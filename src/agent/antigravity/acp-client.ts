import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export class AcpRpcError extends Error {
	constructor(
		message: string,
		readonly code?: number,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "AcpRpcError";
	}
}

export type AcpJsonRpcId = string | number;

type PendingRequest = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer?: NodeJS.Timeout;
};

export interface AcpClientCallbacks {
	onNotification?: (method: string, params: Record<string, unknown>) => void;
	onRequest?: (id: AcpJsonRpcId, method: string, params: Record<string, unknown>) => void;
	onClose?: (code: number | null, stderr: string) => void;
	onError?: (error: Error) => void;
}

function asObject(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export class AcpClient {
	private nextId = 1;
	private readonly pending = new Map<string, PendingRequest>();
	private stderr = "";
	private closed = false;
	private stopping = false;
	private killTimer: NodeJS.Timeout | undefined;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly callbacks: AcpClientCallbacks = {},
	) {
		this.child.stderr.setEncoding("utf8");
		this.child.stderr.on("data", (chunk: string) => {
			this.stderr = (this.stderr + chunk).slice(-65_536);
		});
		this.child.stdin.on("error", () => {
			// Broken pipe on teardown is handled via close/pending rejection.
		});
		this.child.once("error", (error) => {
			this.rejectAll(error);
			this.callbacks.onError?.(error);
			this.handleClose(null);
		});
		this.child.once("close", (code) => this.handleClose(code));

		createInterface({ input: this.child.stdout }).on("line", (line) => {
			if (!line.trim()) return;
			this.handleLine(line);
		});
	}

	get isClosed(): boolean {
		return this.closed || this.stopping;
	}

	get stderrOutput(): string {
		return this.stderr.trim();
	}

	request<T = Record<string, unknown>>(
		method: string,
		params: Record<string, unknown>,
		options?: { timeoutMs?: number; signal?: AbortSignal },
	): Promise<T> {
		if (this.closed || this.stopping) {
			return Promise.reject(new Error("agy ACP client is closed"));
		}
		if (options?.signal?.aborted) {
			return Promise.reject(new Error("Request was aborted"));
		}

		const id = this.nextId++;
		const key = String(id);
		return new Promise<T>((resolve, reject) => {
			const cleanup = () => {
				const entry = this.pending.get(key);
				if (entry?.timer) clearTimeout(entry.timer);
				this.pending.delete(key);
				options?.signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				cleanup();
				reject(new Error("Request was aborted"));
			};
			const entry: PendingRequest = {
				resolve: (value) => {
					cleanup();
					resolve(value as T);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			};
			if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					cleanup();
					reject(new Error(`agy ACP request "${method}" timed out`));
				}, options.timeoutMs);
				entry.timer.unref();
			}
			options?.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(key, entry);
			this.writeJson({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: Record<string, unknown>): void {
		if (this.closed || this.stopping) return;
		this.writeJson({ jsonrpc: "2.0", method, params });
	}

	respond(id: AcpJsonRpcId, result: unknown): void {
		if (this.closed || this.stopping) return;
		this.writeJson({ jsonrpc: "2.0", id, result });
	}

	respondError(id: AcpJsonRpcId, code: number, message: string): void {
		if (this.closed || this.stopping) return;
		this.writeJson({ jsonrpc: "2.0", id, error: { code, message } });
	}

	kill(): void {
		if (this.stopping || this.closed) return;
		this.stopping = true;
		this.rejectAll(new Error("agy ACP client closed"));
		this.child.kill();
		this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 1_000);
		this.killTimer.unref();
	}

	private writeJson(payload: unknown): void {
		try {
			this.child.stdin.write(`${JSON.stringify(payload)}\n`);
		} catch (error) {
			this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private handleLine(line: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			this.callbacks.onError?.(new Error("agy ACP emitted malformed JSON-RPC output"));
			return;
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
		const msg = parsed as Record<string, unknown>;
		const hasId = typeof msg.id === "number" || typeof msg.id === "string";
		const hasMethod = typeof msg.method === "string";

		// Response to one of our outgoing requests
		if (hasId && !hasMethod) {
			const entry = this.pending.get(String(msg.id));
			if (!entry) return;
			if (msg.error !== undefined && msg.error !== null && typeof msg.error === "object") {
				const err = msg.error as Record<string, unknown>;
				const message = typeof err.message === "string" ? err.message : "agy ACP RPC error";
				const code = typeof err.code === "number" ? err.code : undefined;
				entry.reject(new AcpRpcError(message, code, err.data));
			} else {
				entry.resolve(msg.result);
			}
			return;
		}

		// Server -> client request (e.g. session/request_permission)
		if (hasId && hasMethod) {
			this.callbacks.onRequest?.(msg.id as AcpJsonRpcId, msg.method as string, asObject(msg.params));
			return;
		}

		// Server -> client notification (e.g. session/update)
		if (hasMethod) {
			this.callbacks.onNotification?.(msg.method as string, asObject(msg.params));
		}
	}

	private handleClose(code: number | null): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.killTimer);
		this.rejectAll(new Error(`agy ACP exited with code ${code}`));
		this.callbacks.onClose?.(code, this.stderr);
	}

	private rejectAll(error: Error): void {
		for (const entry of this.pending.values()) {
			if (entry.timer) clearTimeout(entry.timer);
			entry.reject(error);
		}
		this.pending.clear();
	}
}
