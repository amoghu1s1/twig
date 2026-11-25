import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { PATHS } from "../../../config.ts";
import type {
	KernelStatus,
	KernelVariable,
	LabCheckResult,
	LabOutput,
	LabStreamEvent,
} from "../../core/contracts/lab.ts";
import type { KernelExecuteRequest, KernelExecutionSummary, LabKernel } from "./kernel-types.ts";

const PYTHON_KERNEL_SCRIPT = path.join(/* turbopackIgnore: true */ PATHS.root, "src", "server", "lab", "python_kernel.py");
const STARTUP_TIMEOUT_MS = 10_000;
const INSPECT_TIMEOUT_MS = 3_000;
const MAX_STREAM_CHARS = 100_000;
const MAX_IMAGES_PER_CELL = 8;
const MAX_IMAGE_BASE64_CHARS = 3_000_000;

interface ActiveExecution {
	cellId: string;
	streamChars: number;
	streamTruncated: boolean;
	imageCount: number;
	onEvent: (event: LabStreamEvent) => void;
	resolve: (summary: KernelExecutionSummary) => void;
	reject: (err: Error) => void;
}

interface PendingInspect {
	resolve: (vars: KernelVariable[]) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class PythonLabKernel implements LabKernel {
	readonly language = "python" as const;
	readonly interpreterPath: string;
	readonly cwd: string;

	private kernelStatus: KernelStatus = "dead";
	private child: ChildProcess | null = null;
	private server: net.Server | null = null;
	private socket: net.Socket | null = null;
	private lineBuffer = "";
	private activeExec: ActiveExecution | null = null;
	private pendingInspects = new Map<string, PendingInspect>();
	private lastVariables: KernelVariable[] = [];
	private startPromise: Promise<void> | null = null;

	constructor(opts: { interpreterPath: string; cwd: string }) {
		this.interpreterPath = opts.interpreterPath;
		this.cwd = opts.cwd;
	}

	status(): KernelStatus {
		return this.kernelStatus;
	}

	lastKnownVariables(): KernelVariable[] {
		return this.lastVariables;
	}

	async start(): Promise<void> {
		if (this.kernelStatus === "idle" && this.socket && this.child) return;
		if (this.startPromise) return this.startPromise;

		this.startPromise = this.doStart().finally(() => {
			this.startPromise = null;
		});
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		if (!fs.existsSync(PYTHON_KERNEL_SCRIPT)) {
			this.kernelStatus = "error";
			throw new Error(`Python kernel script not found at ${PYTHON_KERNEL_SCRIPT}`);
		}
		this.kernelStatus = "starting";
		const token = randomBytes(32).toString("hex");

		let startupTimer: ReturnType<typeof setTimeout> | undefined;
		let startupStderr = "";

		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const fail = (err: Error) => {
				if (settled) return;
				settled = true;
				if (startupTimer) clearTimeout(startupTimer);
				this.kernelStatus = "error";
				void this.cleanupResources();
				reject(err);
			};
			const succeed = () => {
				if (settled) return;
				settled = true;
				if (startupTimer) clearTimeout(startupTimer);
				this.kernelStatus = "idle";
				resolve();
			};

			const srv = net.createServer((conn) => {
				if (this.socket) {
					conn.destroy();
					return;
				}
				let authed = false;
				let authBuf = "";

				conn.on("data", (chunk: Buffer) => {
					const text = chunk.toString("utf-8");
					if (!authed) {
						authBuf += text;
						const nl = authBuf.indexOf("\n");
						if (nl === -1) {
							if (authBuf.length > 4096) conn.destroy();
							return;
						}
						const firstLine = authBuf.slice(0, nl);
						const remainder = authBuf.slice(nl + 1);
						try {
							const msg = JSON.parse(firstLine) as { type?: unknown; token?: unknown };
							if (msg.type === "auth" && msg.token === token) {
								authed = true;
								this.socket = conn;
								this.lineBuffer = remainder;
								this.processBuffer();
								succeed();
								return;
							}
						} catch {
							// Invalid auth packet
						}
						conn.destroy();
						fail(new Error("Python kernel failed authentication handshake."));
						return;
					}
					this.lineBuffer += text;
					this.processBuffer();
				});

				conn.on("error", () => {
					if (!settled) fail(new Error("Python kernel socket error during startup."));
				});

				conn.on("close", () => {
					this.handleDisconnect();
				});
			});

			this.server = srv;
			srv.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));

			srv.listen(0, "127.0.0.1", () => {
				const addr = srv.address();
				if (!addr || typeof addr === "string") {
					fail(new Error("Failed to bind local kernel control socket."));
					return;
				}
				const child = spawn(this.interpreterPath, ["-u", PYTHON_KERNEL_SCRIPT], {
					cwd: this.cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						...process.env,
						MPLBACKEND: "Agg",
						PYTHONUNBUFFERED: "1",
						PYTHONIOENCODING: "utf-8",
						TWIG_KERNEL_PORT: String(addr.port),
						TWIG_KERNEL_TOKEN: token,
					},
				});
				this.child = child;

				child.stdout?.on("data", (buf: Buffer) => {
					const text = buf.toString("utf-8");
					if (this.activeExec) {
						this.forwardStream("stdout", text);
					}
				});

				child.stderr?.on("data", (buf: Buffer) => {
					const text = buf.toString("utf-8");
					if (!settled && startupStderr.length < 4000) {
						startupStderr += text;
					}
					if (this.activeExec) {
						this.forwardStream("stderr", text);
					}
				});

				child.on("error", (err) => {
					fail(new Error(`Failed to start Python (${this.interpreterPath}): ${err.message}`));
				});

				child.on("exit", (code, signal) => {
					const detail = startupStderr.trim();
					if (!settled) {
						fail(
							new Error(
								`Python kernel exited early (code=${code ?? "null"}, signal=${signal ?? "null"})${detail ? `: ${detail}` : ""}`,
							),
						);
					}
					this.handleDisconnect(code, signal);
				});

				startupTimer = setTimeout(() => {
					fail(new Error(`Python kernel startup timed out after ${STARTUP_TIMEOUT_MS}ms.`));
				}, STARTUP_TIMEOUT_MS);
			});
		});
	}

	private handleDisconnect(code?: number | null, signal?: NodeJS.Signals | null): void {
		this.socket = null;
		this.child = null;
		if (this.kernelStatus !== "dead") {
			this.kernelStatus = "dead";
		}
		for (const [, pending] of this.pendingInspects) {
			clearTimeout(pending.timer);
			pending.resolve(this.lastVariables);
		}
		this.pendingInspects.clear();

		if (this.activeExec) {
			const exec = this.activeExec;
			this.activeExec = null;
			exec.onEvent({ type: "status", status: "dead" });
			exec.reject(
				new Error(
					`Python kernel disconnected unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
				),
			);
		}
	}

	private forwardStream(name: "stdout" | "stderr", rawText: string): void {
		const exec = this.activeExec;
		if (!exec || !rawText) return;
		if (exec.streamTruncated) return;

		const remaining = MAX_STREAM_CHARS - exec.streamChars;
		if (remaining <= 0) {
			exec.streamTruncated = true;
			exec.onEvent({
				type: "stream",
				cellId: exec.cellId,
				name,
				text: "\n... [output truncated at 100 KB]",
			});
			return;
		}
		let text = rawText;
		if (text.length > remaining) {
			text = text.slice(0, remaining) + "\n... [output truncated at 100 KB]";
			exec.streamTruncated = true;
		}
		exec.streamChars += text.length;
		exec.onEvent({ type: "stream", cellId: exec.cellId, name, text });
	}

	private processBuffer(): void {
		while (true) {
			const idx = this.lineBuffer.indexOf("\n");
			if (idx === -1) break;
			const rawLine = this.lineBuffer.slice(0, idx).trim();
			this.lineBuffer = this.lineBuffer.slice(idx + 1);
			if (!rawLine) continue;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(rawLine) as Record<string, unknown>;
			} catch {
				continue;
			}
			this.handleProtocolMessage(msg);
		}
	}

	private handleProtocolMessage(msg: Record<string, unknown>): void {
		const type = msg.type;
		if (type === "stream") {
			const name = msg.name === "stderr" ? "stderr" : "stdout";
			const text = typeof msg.text === "string" ? msg.text : "";
			this.forwardStream(name, text);
			return;
		}
		if (type === "output" && this.activeExec) {
			const rawOut = msg.output as LabOutput | undefined;
			if (!rawOut) return;
			const guarded = this.guardOutput(rawOut);
			if (guarded) {
				this.activeExec.onEvent({
					type: "output",
					cellId: this.activeExec.cellId,
					output: guarded,
				});
			}
			return;
		}
		if (type === "check_result" && this.activeExec) {
			const result = msg.result as LabCheckResult | undefined;
			if (result) {
				this.activeExec.onEvent({
					type: "check_result",
					cellId: this.activeExec.cellId,
					result,
				});
			}
			return;
		}
		if (type === "done" && this.activeExec) {
			const exec = this.activeExec;
			this.activeExec = null;
			this.kernelStatus = "idle";
			const variables = Array.isArray(msg.variables) ? (msg.variables as KernelVariable[]) : [];
			this.lastVariables = variables;
			const executionCount = typeof msg.executionCount === "number" ? msg.executionCount : null;
			const durationMs = typeof msg.durationMs === "number" ? msg.durationMs : 0;
			const status = msg.status === "error" || msg.status === "interrupted" ? msg.status : "ok";
			const reloadedModules = Array.isArray(msg.reloadedModules)
				? msg.reloadedModules.filter((m): m is string => typeof m === "string")
				: [];
			exec.onEvent({
				type: "done",
				cellId: exec.cellId,
				executionCount,
				durationMs,
				status,
				variables,
				...(reloadedModules.length > 0 ? { reloadedModules } : {}),
			});
			exec.onEvent({ type: "status", status: "idle" });
			exec.resolve({
				executionCount,
				durationMs,
				status,
				variables,
				...(reloadedModules.length > 0 ? { reloadedModules } : {}),
			});
			return;
		}
		if (type === "vars") {
			const reqId = typeof msg.requestId === "string" ? msg.requestId : "";
			const pending = this.pendingInspects.get(reqId);
			if (pending) {
				clearTimeout(pending.timer);
				this.pendingInspects.delete(reqId);
				const variables = Array.isArray(msg.variables) ? (msg.variables as KernelVariable[]) : [];
				this.lastVariables = variables;
				pending.resolve(variables);
			}
		}
	}

	private guardOutput(output: LabOutput): LabOutput | null {
		const exec = this.activeExec;
		if (!exec) return output;
		if (output.outputType === "display_data" || output.outputType === "execute_result") {
			const png = output.data["image/png"];
			if (png) {
				if (exec.imageCount >= MAX_IMAGES_PER_CELL) {
					return {
						outputType: "display_data",
						data: { "text/plain": "[Image omitted: max 8 images per cell]" },
					};
				}
				if (png.length > MAX_IMAGE_BASE64_CHARS) {
					return {
						outputType: "display_data",
						data: { "text/plain": "[Image omitted: exceeded 2 MiB size limit]" },
					};
				}
				exec.imageCount += 1;
			}
		}
		return output;
	}

	async execute(
		req: KernelExecuteRequest,
		onEvent: (event: LabStreamEvent) => void,
	): Promise<KernelExecutionSummary> {
		if (!this.socket || !this.child || this.kernelStatus === "dead" || this.kernelStatus === "error") {
			await this.start();
		}
		if (!this.socket) throw new Error("Python kernel socket is not connected.");
		if (this.activeExec) throw new Error("Kernel is already executing another cell.");

		this.kernelStatus = "busy";
		onEvent({ type: "status", status: "busy" });

		return new Promise<KernelExecutionSummary>((resolve, reject) => {
			this.activeExec = {
				cellId: req.cellId,
				streamChars: 0,
				streamTruncated: false,
				imageCount: 0,
				onEvent,
				resolve,
				reject,
			};
			const payload = JSON.stringify({
				type: "execute",
				cellId: req.cellId,
				code: req.code,
				role: req.role,
			});
			this.socket!.write(`${payload}\n`, (err) => {
				if (err && this.activeExec) {
					const active = this.activeExec;
					this.activeExec = null;
					this.kernelStatus = "error";
					active.reject(err instanceof Error ? err : new Error(String(err)));
				}
			});
		});
	}

	async interrupt(): Promise<void> {
		if (!this.child || !this.activeExec) return;
		try {
			this.child.kill("SIGINT");
		} catch {
			// Process may have already exited.
		}
	}

	async restart(): Promise<void> {
		await this.shutdown();
		this.lastVariables = [];
		await this.start();
	}

	async inspectVars(): Promise<KernelVariable[]> {
		if (!this.socket || !this.child || this.kernelStatus === "dead" || this.kernelStatus === "error") {
			return [];
		}
		if (this.kernelStatus === "busy" || this.activeExec) {
			return this.lastVariables;
		}
		const requestId = randomUUID();
		return new Promise<KernelVariable[]>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingInspects.delete(requestId);
				resolve(this.lastVariables);
			}, INSPECT_TIMEOUT_MS);
			this.pendingInspects.set(requestId, { resolve, timer });
			this.socket!.write(`${JSON.stringify({ type: "inspect_vars", requestId })}\n`, (err) => {
				if (err) {
					clearTimeout(timer);
					this.pendingInspects.delete(requestId);
					resolve(this.lastVariables);
				}
			});
		});
	}

	async shutdown(): Promise<void> {
		this.kernelStatus = "dead";
		const sock = this.socket;
		if (sock && !sock.destroyed) {
			try {
				sock.write(`${JSON.stringify({ type: "shutdown" })}\n`);
			} catch {
				// Ignore write failure on closing socket.
			}
		}
		await this.cleanupResources();
	}

	private async cleanupResources(): Promise<void> {
		const child = this.child;
		this.child = null;
		const sock = this.socket;
		this.socket = null;
		const srv = this.server;
		this.server = null;

		if (sock && !sock.destroyed) {
			try {
				sock.destroy();
			} catch {
				// ignore
			}
		}
		if (srv) {
			try {
				srv.close();
			} catch {
				// ignore
			}
		}
		if (child && child.exitCode === null && child.signalCode === null) {
			await new Promise<void>((resolve) => {
				let done = false;
				const finish = () => {
					if (done) return;
					done = true;
					clearTimeout(termTimer);
					clearTimeout(killTimer);
					resolve();
				};
				child.once("exit", finish);
				const termTimer = setTimeout(() => {
					try {
						child.kill("SIGTERM");
					} catch {
						finish();
					}
				}, 300);
				const killTimer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// ignore
					}
					finish();
				}, 1500);
			});
		}
	}
}
