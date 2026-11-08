import { findMistakes, mergeMistakes, type MistakeRecord } from "../core/mistakes.ts";
import type { PiEngine } from "../agent/models.ts";
import { readMistakes, updateMistakes } from "../store/mistakes.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { analyzeMistake } from "./mistake-analysis.ts";

/**
 * Finding and analyzing the learner's mistakes (mistakes fork, 2026-11-08 —
 * ported from vvcdev/learnharness). A scan reads a session's saved record,
 * adds the misses it has not seen (keyed by the answer's tool call, so
 * scanning twice never duplicates), and queues each new one for the short
 * error analysis. The same scan serves the after-every-turn trigger and the
 * "scan past sessions" backfill.
 *
 * COST (owner-facing, mistakes fork): the analyst is a cheap-slot model call
 * per miss, so the agent settings carry an opt-out (`auto`) and a rolling
 * 24-hour attempt cap (`dailyCap`). Both are enforced here; the explicit
 * scan records misses either way but never exceeds the cap.
 */

/** Test seam: a scripted engine for the analyst. */
export const analysisEngineOverride: { current?: PiEngine } = {};

const DAY_MS = 24 * 60 * 60 * 1000;

interface AnalysisState {
	running: Set<string>;
	total: number;
	done: number;
	controller: AbortController | null;
}

/** One queue per process (globalThis: Next compiles each route as its own module). */
function state(): AnalysisState {
	const g = globalThis as typeof globalThis & { __lhMistakeAnalysis?: AnalysisState };
	return (g.__lhMistakeAnalysis ??= { running: new Set(), total: 0, done: 0, controller: null });
}

export interface AnalysisProgress {
	/** Analyses queued or running right now. */
	active: number;
	/** Of the current batch: how many have finished / how many there were. */
	done: number;
	total: number;
}

export function analysisProgress(): AnalysisProgress {
	const s = state();
	return { active: s.running.size, done: s.done, total: s.total };
}

function kindOf(kind: string | undefined): "teach" | "practice" | "chat" {
	return kind === "practice" || kind === "chat" ? kind : "teach";
}

/** How many model calls the analyst has started in the rolling 24 hours.
 *  Every finished attempt stamps `analyzedAt` (ready or failed), so the cap
 *  counts real spend, not just successes. */
export function analysesInLastDay(now = Date.now(), records = readMistakes()): number {
	const cutoff = now - DAY_MS;
	return records.filter((r) => r.analyzedAt && Date.parse(r.analyzedAt) >= cutoff).length;
}

/** The agent settings gate: auto analysis ON unless explicitly opted out. */
export function autoAnalysisEnabled(): boolean {
	return effectiveSettings().agent.mistakeAnalysis.auto;
}

/** How many misses a session holds that are not recorded yet (no writes). */
export function countNewMistakes(chatId: string): number {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return 0;
	const known = new Set(readMistakes().map((r) => r.id));
	return findMistakes(chatId, record.messages).filter((d) => !known.has(d.id)).length;
}

/** Record a session's new misses; returns their ids (analysis NOT started). */
export function recordChatMistakes(chatId: string): string[] {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return [];
	const drafts = findMistakes(chatId, record.messages);
	let added: MistakeRecord[] = [];
	const existing = readMistakes();
	// Nothing new and nothing to refresh → no write, no event.
	const known = new Set(existing.map((r) => r.id));
	// The current shell has no per-session source folder (the fork's lesson
	// sources are a different feature); the field stays for record-shape
	// compatibility with the fork's tab.
	const sources: string[] = [];
	const kind = kindOf(record.kind);
	const stale = existing.some(
		(r) => r.chatId === chatId && (r.sessionTitle !== record.title || r.sessionKind !== kind || r.sources.join("\n") !== sources.join("\n")),
	);
	if (!stale && drafts.every((d) => known.has(d.id))) return [];
	updateMistakes((records) => {
		const merged = mergeMistakes(records, drafts, { chatId, title: record.title, kind, sources, now: new Date().toISOString() });
		added = merged.added;
		return merged.records;
	});
	return added.map((r) => r.id);
}

/** Record every session's misses (the backfill); returns the new ids. */
export function recordAllMistakes(): string[] {
	const ids: string[] = [];
	for (const chat of stores.chatStore.listChats()) ids.push(...recordChatMistakes(chat.id));
	return ids;
}

function patch(id: string, fields: Partial<MistakeRecord>): void {
	updateMistakes((records) => records.map((r) => (r.id === id ? { ...r, ...fields } : r)));
}

/** Queue analyses for these mistakes (pending ones not already running),
 *  honoring the settings' rolling-24h attempt cap. */
export function enqueueAnalyses(ids: readonly string[]): void {
	if (ids.length === 0) return;
	const s = state();
	const records = readMistakes();
	const byId = new Map(records.map((r) => [r.id, r]));
	const fresh = ids.filter((id) => !s.running.has(id) && byId.has(id));
	if (fresh.length === 0) return;
	const cap = effectiveSettings().agent.mistakeAnalysis.dailyCap;
	// In-flight calls have not stamped `analyzedAt` yet — count them too so
	// two near-simultaneous scans cannot both spend the last permit.
	let used = analysesInLastDay(Date.now(), records) + s.running.size;
	const allowed: string[] = [];
	for (const id of fresh) {
		if (used >= cap) {
			// No call, no `analyzedAt` (that would count this non-attempt
			// against tomorrow's budget too). The tab explains and retries.
			patch(id, {
				status: "failed",
				analysis: undefined,
				error: `Daily analysis limit reached (${cap} in the last 24 hours). Raise it in Settings → Agent, or retry tomorrow.`,
			});
			continue;
		}
		used += 1;
		allowed.push(id);
	}
	if (allowed.length === 0) return;
	if (s.running.size === 0) {
		s.total = 0;
		s.done = 0;
		s.controller = new AbortController();
	}
	const controller = (s.controller ??= new AbortController());
	for (const id of allowed) {
		const record = byId.get(id)!;
		s.running.add(id);
		s.total += 1;
		void (async () => {
			try {
				const analysis = await analyzeMistake(record, { engine: analysisEngineOverride.current, signal: controller.signal });
				patch(id, { status: "ready", analysis, error: undefined, analyzedAt: new Date().toISOString() });
			} catch (err) {
				const aborted = err instanceof Error && err.name === "AbortError";
				patch(id, {
					status: "failed",
					error: aborted ? "Cancelled." : err instanceof Error ? err.message : "Analysis failed.",
					analyzedAt: new Date().toISOString(),
				});
			} finally {
				s.running.delete(id);
				s.done += 1;
				if (s.running.size === 0) s.controller = null;
			}
		})();
	}
}

/** After a turn settles: record the session's new misses and analyze them
 *  (unless the user opted out of the automatic cheap-model calls). */
export function mistakesAfterTurn(chatId: string): void {
	if (process.env.NODE_ENV === "test") return; // scripted chats are fixtures
	try {
		if (!autoAnalysisEnabled()) return;
		enqueueAnalyses(recordChatMistakes(chatId));
	} catch (err) {
		console.error(`[chat ${chatId}] mistakes scan failed:`, err);
	}
}

/** Re-run one mistake's analysis (a failed or stale one). */
export function retryMistake(id: string): boolean {
	if (!readMistakes().some((r) => r.id === id)) return false;
	patch(id, { status: "pending", error: undefined });
	enqueueAnalyses([id]);
	return true;
}

/** Abort every queued/running analysis (they land as failed: Cancelled). */
export function cancelAnalyses(): void {
	state().controller?.abort();
}

export function deleteMistake(id: string): boolean {
	let found = false;
	updateMistakes((records) => records.filter((r) => (r.id === id ? ((found = true), false) : true)));
	return found;
}
