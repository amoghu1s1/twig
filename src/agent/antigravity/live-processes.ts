export type LiveProcessMode = "waiting-tools" | "idle";

export type LiveAntigravityProcess = {
	readonly owner: symbol;
	readonly sessionId: string | undefined;
	readonly mode: LiveProcessMode;
	toolCallIds: string[];
	kill(): void;
};

export const LIVE_PROCESS_IDLE_TIMEOUT_MS = 10 * 60_000;

/** Test seam for deterministic idle expiry tests. */
export const liveProcessIdleTimeoutMs = { current: LIVE_PROCESS_IDLE_TIMEOUT_MS };

const liveProcesses = new Map<LiveAntigravityProcess, NodeJS.Timeout>();

export function addLiveProcess(process: LiveAntigravityProcess): void {
	removeLiveProcess(process);
	const timer = setTimeout(() => {
		removeLiveProcess(process);
		process.kill();
	}, liveProcessIdleTimeoutMs.current);
	timer.unref();
	liveProcesses.set(process, timer);
}

function hasSameIds(ids: string[], otherIds: string[]): boolean {
	return ids.length === otherIds.length && new Set(otherIds).size === otherIds.length && ids.every((id) => otherIds.includes(id));
}

export function getLiveProcessForTools(
	toolCallIds: string[],
	owner: symbol,
	sessionId: string | undefined,
): LiveAntigravityProcess | null {
	if (!sessionId || toolCallIds.length === 0) return null;
	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId && process.mode === "waiting-tools" && hasSameIds(process.toolCallIds, toolCallIds)) {
			return process;
		}
	}
	return null;
}

export function getLiveProcessForSession(
	owner: symbol,
	sessionId: string | undefined,
): LiveAntigravityProcess | null {
	if (!sessionId) return null;
	for (const process of liveProcesses.keys()) {
		if (process.owner === owner && process.sessionId === sessionId && process.mode === "idle") {
			return process;
		}
	}
	return null;
}

export function removeLiveProcess(process: LiveAntigravityProcess): void {
	clearTimeout(liveProcesses.get(process));
	liveProcesses.delete(process);
}

/** Test helper to tear down all tracked live processes between tests. */
export function killAllLiveProcesses(): void {
	for (const process of [...liveProcesses.keys()]) {
		removeLiveProcess(process);
		process.kill();
	}
}
