import { emit } from "../../core/events.ts";
import { hashCellSource } from "../../core/lab-python.ts";
import type {
	KernelStatus,
	KernelVariable,
	LabCheckResult,
	LabNudgeLevel,
	LabOutput,
	LabSessionMeta,
	LabStreamEvent,
} from "../../core/contracts/lab.ts";
import { stores } from "../stores.ts";
import { resolveDefaultPython } from "./python-envs.ts";
import { PythonLabKernel } from "./python-kernel.ts";
import { readLabNotebook, writeLabNotebook } from "./workspace.ts";

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;

interface ManagedKernel {
	chatId: string;
	kernel: PythonLabKernel;
	meta: LabSessionMeta;
	lastActivityAt: number;
	queue: Promise<void>;
}

interface KernelManagerState {
	kernels: Map<string, ManagedKernel>;
	hooksInstalled: boolean;
}

interface GlobalWithLabManager {
	__lhLabKernelManager?: KernelManagerState;
}

function getState(): KernelManagerState {
	const g = globalThis as typeof globalThis & GlobalWithLabManager;
	if (!g.__lhLabKernelManager) {
		g.__lhLabKernelManager = {
			kernels: new Map(),
			hooksInstalled: false,
		};
	}
	const state = g.__lhLabKernelManager;
	if (!state.hooksInstalled) {
		state.hooksInstalled = true;
		const reaper = setInterval(() => {
			const cutoff = Date.now() - IDLE_TIMEOUT_MS;
			for (const [chatId, entry] of state.kernels.entries()) {
				if (entry.kernel.status() !== "busy" && entry.lastActivityAt < cutoff) {
					state.kernels.delete(chatId);
					void entry.kernel.shutdown();
				}
			}
		}, REAPER_INTERVAL_MS);
		reaper.unref?.();

		const shutdownAll = () => {
			for (const [, entry] of state.kernels.entries()) {
				void entry.kernel.shutdown();
			}
			state.kernels.clear();
		};
		process.once("beforeExit", shutdownAll);
		process.once("SIGTERM", shutdownAll);
		process.once("SIGINT", shutdownAll);
	}
	return state;
}

function appendStreamOrOutput(outputs: LabOutput[], incoming: LabOutput): void {
	if (incoming.outputType === "stream") {
		const prev = outputs.at(-1);
		if (prev && prev.outputType === "stream" && prev.name === incoming.name) {
			prev.text += incoming.text;
			return;
		}
	}
	outputs.push(incoming);
}

async function ensureManagedKernel(chatId: string, meta: LabSessionMeta): Promise<ManagedKernel> {
	const state = getState();
	const existing = state.kernels.get(chatId);
	if (
		existing &&
		existing.meta.workspaceDir === meta.workspaceDir &&
		(!meta.interpreterPath || existing.meta.interpreterPath === meta.interpreterPath)
	) {
		existing.lastActivityAt = Date.now();
		return existing;
	}
	if (existing) {
		state.kernels.delete(chatId);
		await existing.kernel.shutdown();
	}

	const configuredPython = stores.settingsStore.readSettings()?.lab?.pythonPath;
	const interpreterPath =
		meta.interpreterPath?.trim() ||
		(await resolveDefaultPython({
			workspaceDir: meta.workspaceDir,
			configuredPythonPath: configuredPython,
		}));
	if (!interpreterPath) {
		throw new Error("No Python 3 interpreter found on this machine. Select or install Python in Settings.");
	}
	const resolvedMeta: LabSessionMeta = { ...meta, interpreterPath };
	const kernel = new PythonLabKernel({
		interpreterPath,
		cwd: resolvedMeta.workspaceDir,
	});
	const managed: ManagedKernel = {
		chatId,
		kernel,
		meta: resolvedMeta,
		lastActivityAt: Date.now(),
		queue: Promise.resolve(),
	};
	state.kernels.set(chatId, managed);
	return managed;
}

export function getLabKernelState(chatId: string): {
	status: KernelStatus;
	interpreterPath?: string;
	variables: KernelVariable[];
} {
	const entry = getState().kernels.get(chatId);
	if (!entry) return { status: "dead", variables: [] };
	return {
		status: entry.kernel.status(),
		interpreterPath: entry.kernel.interpreterPath,
		variables: entry.kernel.lastKnownVariables(),
	};
}

export async function inspectLabVariables(chatId: string): Promise<KernelVariable[]> {
	const entry = getState().kernels.get(chatId);
	if (!entry) return [];
	entry.lastActivityAt = Date.now();
	return entry.kernel.inspectVars();
}

export async function interruptLabKernel(chatId: string): Promise<void> {
	const entry = getState().kernels.get(chatId);
	if (!entry) return;
	entry.lastActivityAt = Date.now();
	await entry.kernel.interrupt();
}

export async function restartLabKernel(chatId: string, meta?: LabSessionMeta): Promise<KernelStatus> {
	const state = getState();
	const entry = state.kernels.get(chatId);
	if (entry) {
		entry.lastActivityAt = Date.now();
		await entry.kernel.restart();
		return entry.kernel.status();
	}
	if (meta) {
		const fresh = await ensureManagedKernel(chatId, meta);
		await fresh.kernel.start();
		return fresh.kernel.status();
	}
	return "dead";
}

export async function shutdownLabKernel(chatId: string): Promise<void> {
	const state = getState();
	const entry = state.kernels.get(chatId);
	if (!entry) return;
	state.kernels.delete(chatId);
	await entry.kernel.shutdown();
}

export async function setLabInterpreter(
	chatId: string,
	meta: LabSessionMeta,
	interpreterPath: string,
): Promise<{ meta: LabSessionMeta; status: KernelStatus }> {
	await shutdownLabKernel(chatId);
	const nextMeta: LabSessionMeta = { ...meta, interpreterPath: interpreterPath.trim() };
	stores.chatStore.saveLabMeta(chatId, nextMeta);
	const managed = await ensureManagedKernel(chatId, nextMeta);
	await managed.kernel.start();
	emit("lab-changed", { chatId });
	return { meta: managed.meta, status: managed.kernel.status() };
}

export function updateLabNudgeLevel(
	chatId: string,
	meta: LabSessionMeta,
	nudgeLevel: LabNudgeLevel,
): LabSessionMeta {
	const nextMeta: LabSessionMeta = { ...meta, nudgeLevel };
	stores.chatStore.saveLabMeta(chatId, nextMeta);
	const entry = getState().kernels.get(chatId);
	if (entry) entry.meta = nextMeta;
	emit("lab-changed", { chatId });
	return nextMeta;
}

export async function executeLabCell(
	chatId: string,
	meta: LabSessionMeta,
	req: { cellId: string; code?: string; markLearnerEdited?: boolean },
	onEvent: (event: LabStreamEvent) => void,
): Promise<void> {
	const managed = await ensureManagedKernel(chatId, meta);
	managed.lastActivityAt = Date.now();

	const task = managed.queue.then(async () => {
		const { notebook } = readLabNotebook(managed.meta);
		const target = notebook.cells.find((c) => c.id === req.cellId);
		if (!target) {
			onEvent({ type: "kernel_error", message: `Cell ${req.cellId} was not found in notebook.` });
			return;
		}
		if (target.cellType !== "code") {
			onEvent({ type: "kernel_error", message: `Cell ${req.cellId} is not a code cell.` });
			return;
		}
		if (typeof req.code === "string" && req.code !== target.source) {
			target.source = req.code;
			if (req.markLearnerEdited ?? true) target.learnerEdited = true;
			writeLabNotebook(managed.meta, notebook);
		}

		const collectedOutputs: LabOutput[] = [];
		let checkResult: LabCheckResult | undefined;
		let finalDoneEvent: Extract<LabStreamEvent, { type: "done" }> | null = null;

		try {
			const summary = await managed.kernel.execute(
				{ cellId: target.id, code: target.source, role: target.role },
				(event) => {
					if (event.type === "stream") {
						appendStreamOrOutput(collectedOutputs, {
							outputType: "stream",
							name: event.name,
							text: event.text,
						});
						onEvent(event);
					} else if (event.type === "output") {
						appendStreamOrOutput(collectedOutputs, event.output);
						onEvent(event);
					} else if (event.type === "check_result") {
						checkResult = event.result;
						onEvent(event);
					} else if (event.type === "done") {
						// Delay emitting final done until outputs persist to disk.
						finalDoneEvent = event;
					} else {
						onEvent(event);
					}
				},
			);

			// Re-read the notebook in case another cell's text was edited while running.
			const latest = readLabNotebook(managed.meta);
			const persistCell = latest.notebook.cells.find((c) => c.id === req.cellId);
			let revision = latest.revision;
			const sourceHashAtRun = hashCellSource(target.source);
			const lastExecutedAt = new Date().toISOString();
			let failedRunCount = persistCell?.failedRunCount ?? 0;
			if (persistCell) {
				const executionFailed = summary.status !== "ok" || checkResult?.passed === false;
				failedRunCount = executionFailed ? (persistCell.failedRunCount ?? 0) + 1 : 0;
				persistCell.executionCount = summary.executionCount;
				persistCell.durationMs = summary.durationMs;
				persistCell.outputs = collectedOutputs;
				persistCell.sourceHashAtRun = sourceHashAtRun;
				persistCell.lastExecutedAt = lastExecutedAt;
				persistCell.failedRunCount = failedRunCount;
				if (checkResult) persistCell.checkResult = checkResult;
				else if (persistCell.role === "check") delete persistCell.checkResult;
				if (persistCell.role === "predict" && persistCell.prediction) {
					persistCell.prediction = { ...persistCell.prediction, revealed: true };
				}
				const written = writeLabNotebook(managed.meta, latest.notebook);
				if (written.ok) revision = written.revision;
			}
			managed.lastActivityAt = Date.now();
			emit("lab-changed", { chatId, revision });
			if (finalDoneEvent) {
				onEvent({
					...(finalDoneEvent as Extract<LabStreamEvent, { type: "done" }>),
					revision,
					sourceHashAtRun,
					lastExecutedAt,
					failedRunCount,
					...(summary.reloadedModules?.length ? { reloadedModules: summary.reloadedModules } : {}),
				});
			}
		} catch (err) {
			onEvent({
				type: "kernel_error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	});

	managed.queue = task.catch(() => undefined);
	await task;
}
