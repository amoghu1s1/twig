/**
 * THE READING COMPANION (docs/readings.md §14): answers the learner's
 * questions inside a reading — one streamed answer per exchange.
 * Learner-requested, background, never chat-woken.
 *
 * The run registry follows the readings pipeline (one globalThis row per
 * live exchange, its own abort controller and usage, surfaced in the
 * activity dock, under the shared background-LLM semaphore — owner
 * ruling: answers queue in the pool like every background job). What it
 * adds is a LIVE VIEW per run: the answer-so-far and the activity line,
 * pushed to subscribers (the SSE route) on every token. The record only
 * takes the final answer; a reconnect replays the live view.
 *
 * Citations: a streamed answer is visible before it can be validated, so
 * there is no submit/validate retry here. The instrumented web tools log
 * every successful fetch; at settle the answer's Sources are the fetched
 * URLs it links, and every other link is stored as unverified (owner
 * ruling, 2026-10-28). Dependencies arrive by injection (the agent layer
 * never imports server/store).
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, AgentTool } from "@earendil-works/pi-agent-core";
import type { ModelRole } from "../../../config.ts";
import { PATHS } from "../../../config.ts";
import { emit } from "../../core/events.ts";
import type { ReadingDiscussionStore, ReadingStore } from "../../core/ports.ts";
import type { SearchProvider } from "../../core/search.ts";
import {
	accumulateJobUsage,
	discussionThreads,
	piUsageToStep,
	type DiscussionExchange,
	type DiscussionThread,
	type JobUsage,
	type ReadingDiscussionRecord,
	type ReadingMode,
	type ReadingRecord,
} from "../../core/contracts.ts";
import { fetchSucceeded, normalizeUrl, readingMarkdown } from "../../core/readings.ts";
import { answerCitations } from "../../core/reading-discussions.ts";
import { modelsNotConfigured, ROLE_SLOT, type ModelSlotName, type ProviderKeyMissing } from "../../core/settings.ts";
import type { PiEngine } from "../models.ts";
import { createWebTools } from "../tools/web.ts";
import { createPdfReadTools } from "../tools/pdf-read.ts";
import { healToolRecord } from "../tools/heal.ts";
import { runSubagent } from "./pi-run.ts";
import { withBgLlmSlot } from "./bg-llm-semaphore.ts";

// ─── prompt composition ─────────────────────────────────────────────────────

const DISCUSS_PROMPTS = path.join(PATHS.root, "src", "agent", "prompts", "discuss");
const SHARED_PROMPTS = path.join(PATHS.root, "src", "agent", "prompts", "shared");
/** The writer's shared set: voice, accuracy, formatting. */
const SHARED_FRAGMENTS = ["10-voice.md", "15-accuracy.md", "40-formatting.md"];

function readPrompt(file: string): string {
	try {
		return fs.readFileSync(file, "utf-8").trim();
	} catch {
		return "";
	}
}

/** base → source mode → shared appendix. */
export function composeCompanionPrompt(mode: ReadingMode): string {
	return [
		readPrompt(path.join(DISCUSS_PROMPTS, "00-base.md")),
		readPrompt(path.join(DISCUSS_PROMPTS, `05-${mode}.md`)),
		...SHARED_FRAGMENTS.map((f) => readPrompt(path.join(SHARED_PROMPTS, f))),
	]
		.filter(Boolean)
		.join("\n\n---\n\n");
}

function quote(text: string): string {
	return `> ${text.replace(/\n/g, "\n> ")}`;
}

/** The companion's task text: the reading, what it was written from (the
 *  frozen snapshot minus the transcript — the reading already distils it),
 *  this thread so far, and the question. Pure. */
export function companionTaskText(
	reading: Pick<ReadingRecord, "title" | "kind" | "mode" | "body" | "terms" | "sections" | "sources" | "furtherReading" | "createdAt" | "snapshot" | "anchor">,
	thread: Pick<DiscussionThread, "passage" | "exchanges">,
	exchange: Pick<DiscussionExchange, "id" | "question" | "mode">,
): string {
	const s = reading.snapshot;
	const out: string[] = [];
	out.push(
		`# Task\n\nAnswer the learner's question about the reading below. Source mode: ${
			exchange.mode === "researched" ? "researched (web tools available; link only pages you fetched)" : "model knowledge only (no web access, no URLs)"
		}.`,
	);
	out.push(`# The reading\n\n<reading>\n${readingMarkdown(reading).trim()}\n</reading>`);
	if (reading.anchor.topic) out.push(`# The topic it was written for\n\n${reading.anchor.topic}`);
	if (s.sessionTitle) out.push(`# The lesson it sits beside\n\n${s.sessionTitle}`);
	if (s.assessment) out.push(`# The probe's read of where the learner stands (when the reading was written)\n\n${s.assessment}`);
	if (s.plan) out.push(`# The lesson plan (when the reading was written; statuses: visited / current / upcoming)\n\n${s.plan}`);
	if (s.propositions && s.propositions.length > 0) {
		out.push(`# Propositions from the learner's knowledge map\n\n${s.propositions.map((p) => `- **${p.name}** — ${p.statement}`).join("\n")}`);
	}
	if (s.chains && s.chains.length > 0) out.push(`# Reasoning chains among them (premises ⟹ conclusion)\n\n${s.chains.map((c) => `- ${c}`).join("\n")}`);
	if (thread.passage) out.push(`# The passage the learner selected\n\n${quote(thread.passage)}`);
	const earlier = thread.exchanges.filter((x) => x.id !== exchange.id && x.status === "done" && x.answer);
	if (earlier.length > 0) {
		out.push(
			`# This thread so far\n\n${earlier.map((x) => `**Learner:** ${x.question}\n\n**You:** ${x.answer}`).join("\n\n---\n\n")}`,
		);
	}
	out.push(`# The question now\n\n${exchange.question}`);
	return out.join("\n\n");
}

// ─── the run registry + live view ───────────────────────────────────────────

/** The dock's row for one live answer. */
export interface RunningAnswer {
	/** The exchange id (the row key and the abort target). */
	id: string;
	readingId: string;
	threadId: string;
	title: string;
	chatId?: string;
	startedAt: number;
	activity: string;
}

/** What a subscriber sees: the answer so far + the activity line. */
export interface LiveAnswerView {
	status: "queued" | "answering";
	text: string;
	activity: string;
}

export type LiveAnswerListener = (view: LiveAnswerView | "settled") => void;

interface LiveRun {
	controller: AbortController;
	row: RunningAnswer;
	view: LiveAnswerView;
	listeners: Set<LiveAnswerListener>;
}

interface LhDiscussionGlobal {
	__lhDiscussionRuns?: Map<string, LiveRun>;
}

function runs(): Map<string, LiveRun> {
	const g = globalThis as typeof globalThis & LhDiscussionGlobal;
	return (g.__lhDiscussionRuns ??= new Map());
}

/** The dock's rows: every answer being written, oldest first. */
export function answerRunStatuses(): RunningAnswer[] {
	return [...runs().values()].map((r) => ({ ...r.row })).sort((a, b) => a.startedAt - b.startedAt);
}

/** Subscribe to one exchange's live view. Returns null when no run is live
 *  for it in this process (the caller answers "settled"); otherwise the
 *  current view (replayed first) and an unsubscribe. */
export function subscribeAnswer(exchangeId: string, listener: LiveAnswerListener): { view: LiveAnswerView; unsubscribe: () => void } | null {
	const run = runs().get(exchangeId);
	if (!run) return null;
	run.listeners.add(listener);
	return { view: { ...run.view }, unsubscribe: () => run.listeners.delete(listener) };
}

function publish(run: LiveRun): void {
	const view = { ...run.view };
	for (const l of run.listeners) l(view);
}

// ─── the pipeline ───────────────────────────────────────────────────────────

export interface DiscussionPipelineDeps {
	readingStore: ReadingStore;
	discussionStore: ReadingDiscussionStore;
	/** The companion engine (the writer's role), settings-resolved per run. */
	engineFor?: (role: ModelRole) => PiEngine | undefined;
	/** Test seam: a scripted engine wins over engineFor. */
	engine?: PiEngine;
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
	searchProvider?: () => SearchProvider | null;
	/** A finished exchange (status done) — the server delivers the teacher's
	 *  marker from here. Never throws into the run. */
	onAnswered?: (reading: ReadingRecord, thread: DiscussionThread, exchange: DiscussionExchange) => void;
	/** Turn caps (tests shrink them). */
	maxTurns?: { researched: number; model: number };
}

export interface DiscussionPipeline {
	/** Fire-and-forget: run a queued exchange to a terminal state. */
	start(readingId: string, threadId: string, exchangeId: string): void;
	/** Awaitable run (tests, and start's body). Never throws. */
	run(readingId: string, threadId: string, exchangeId: string): Promise<void>;
	/** Stop a live answer. The exchange settles as error "Stopped",
	 *  keeping the partial answer. */
	abort(exchangeId: string): boolean;
	/** Stop every live answer of one reading (its delete). */
	abortReading(readingId: string): void;
	/** Refusal check before queueing: the writer role's model/key chain. */
	refusal(): string | null;
	/** One record's orphan check: exchanges left queued/answering with no
	 *  live run here and a stale record. */
	settleIfOrphaned(r: ReadingDiscussionRecord): ReadingDiscussionRecord;
}

const STOPPED = "Stopped";
const HEARTBEAT_MS = 30_000;
export const STALE_MS = 120_000;

/** Patch one exchange inside a record (pure). */
export function patchExchange(
	r: ReadingDiscussionRecord,
	threadId: string,
	exchangeId: string,
	patch: Partial<DiscussionExchange>,
): ReadingDiscussionRecord {
	const fix = (t: DiscussionThread): DiscussionThread =>
		t.id !== threadId ? t : { ...t, exchanges: t.exchanges.map((x) => (x.id === exchangeId ? { ...x, ...patch } : x)) };
	return { ...r, side: fix(r.side), threads: r.threads.map(fix) };
}

export function createDiscussionPipeline(deps: DiscussionPipelineDeps): DiscussionPipeline {
	const { readingStore, discussionStore } = deps;
	const caps = deps.maxTurns ?? { researched: 16, model: 2 };

	function engine(): PiEngine | undefined {
		return deps.engine ?? deps.engineFor?.("writer");
	}

	function refusal(): string | null {
		const e = engine();
		if (!e) return modelsNotConfigured([ROLE_SLOT.writer]).error;
		const key = deps.providerKeyMissing?.(e.model.provider, ROLE_SLOT.writer) ?? null;
		return key ? key.error : null;
	}

	function patch(readingId: string, threadId: string, exchangeId: string, p: Partial<DiscussionExchange>): ReadingDiscussionRecord | null {
		return discussionStore.mutateDiscussion(readingId, (cur) => (cur ? patchExchange(cur, threadId, exchangeId, p) : null));
	}

	function find(r: ReadingDiscussionRecord | null, threadId: string, exchangeId: string) {
		const thread = r ? discussionThreads(r).find((t) => t.id === threadId) : undefined;
		const exchange = thread?.exchanges.find((x) => x.id === exchangeId);
		return thread && exchange ? { thread, exchange } : null;
	}

	async function run(readingId: string, threadId: string, exchangeId: string): Promise<void> {
		const reading = readingStore.getReading(readingId);
		const found = find(discussionStore.getDiscussion(readingId), threadId, exchangeId);
		if (!reading || !found || found.exchange.status !== "queued") return;
		if (runs().has(exchangeId)) return;
		const { thread, exchange } = found;
		const controller = new AbortController();
		const live: LiveRun = {
			controller,
			row: { id: exchangeId, readingId, threadId, title: reading.title, chatId: reading.anchor.chatId, startedAt: Date.now(), activity: "queued" },
			view: { status: "queued", text: "", activity: "queued" },
			listeners: new Set(),
		};
		runs().set(exchangeId, live);
		emit("activity-changed", {});

		const setActivity = (line: string) => {
			live.row.activity = line;
			live.view.activity = line;
			publish(live);
			emit("activity-changed", {});
		};

		let pdfDir: string | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let usage: JobUsage | undefined;
		try {
			const refused = refusal();
			if (refused) {
				patch(readingId, threadId, exchangeId, { status: "error", error: refused, activity: undefined });
				return;
			}
			const e = engine()!;
			patch(readingId, threadId, exchangeId, { status: "answering", activity: "waiting for a model slot" });
			live.view.status = "answering";
			setActivity("waiting for a model slot");
			// Heartbeat: a live run keeps its record fresh, so the stale check
			// only ever catches orphans.
			heartbeat = setInterval(() => discussionStore.mutateDiscussion(readingId, (cur) => cur), HEARTBEAT_MS);
			await withBgLlmSlot(controller.signal, async () => {
				const fetched = new Set<string>();
				const tools: AgentTool<any>[] = [];
				if (exchange.mode === "researched") {
					pdfDir = await fsp.mkdtemp(path.join(os.tmpdir(), "lh-discuss-"));
					const raw = healToolRecord({
						...createWebTools(deps.searchProvider ?? (() => null)),
						...createPdfReadTools(pdfDir),
					});
					for (const tool of Object.values(raw)) tools.push(instrument(tool, fetched, setActivity));
				}
				setActivity(exchange.mode === "researched" ? "researching" : "answering");
				const blocks = new Map<number, string>();
				const result = await runSubagent(tools, {
					role: "writer",
					engine: e,
					systemPrompt: composeCompanionPrompt(exchange.mode),
					prompt: companionTaskText(reading, thread, exchange),
					maxTurns: exchange.mode === "researched" ? caps.researched : caps.model,
					abortSignal: controller.signal,
					onEvent: (event: AgentEvent) => {
						// Accumulate the deltas ourselves: pi's `partial` is the shared
						// live message, not an event-time snapshot.
						if (event.type === "message_start" && (event.message as { role?: string }).role === "assistant") {
							blocks.clear();
							live.view.text = "";
							publish(live);
						} else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
							const { contentIndex, delta } = event.assistantMessageEvent;
							blocks.set(contentIndex, (blocks.get(contentIndex) ?? "") + delta);
							live.view.text = [...blocks.entries()]
								.sort(([a], [b]) => a - b)
								.map(([, t]) => t)
								.join("");
							publish(live);
						}
					},
					onAssistantMessage: (m) => {
						usage = accumulateJobUsage(usage, `${m.provider}:${m.model}`, piUsageToStep(m.usage));
						patch(readingId, threadId, exchangeId, { usage });
					},
				});
				const answer = result.text.trim();
				if (!answer) throw new Error("The companion finished without an answer.");
				const { sources, unverifiedUrls } = answerCitations(answer, fetched, exchange.mode);
				const saved = patch(readingId, threadId, exchangeId, {
					status: "done",
					answer,
					...(sources.length > 0 ? { sources } : {}),
					...(unverifiedUrls.length > 0 ? { unverifiedUrls } : {}),
					...(usage ? { usage } : {}),
					activity: undefined,
					error: undefined,
					answeredAt: new Date().toISOString(),
				});
				const settled = find(saved, threadId, exchangeId);
				if (settled) {
					try {
						deps.onAnswered?.(reading, settled.thread, settled.exchange);
					} catch (err) {
						console.error(`[discussion ${exchangeId}] onAnswered failed:`, err);
					}
				}
			});
		} catch (err) {
			const aborted = controller.signal.aborted;
			const reason = aborted ? STOPPED : err instanceof Error ? err.message : String(err);
			if (!aborted) console.error(`[discussion ${exchangeId}] failed:`, err);
			const partial = live.view.text.trim();
			patch(readingId, threadId, exchangeId, {
				status: "error",
				error: reason,
				activity: undefined,
				...(partial ? { answer: partial } : {}),
				...(usage ? { usage } : {}),
			});
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			runs().delete(exchangeId);
			for (const l of live.listeners) l("settled");
			live.listeners.clear();
			emit("activity-changed", {});
			if (pdfDir) await fsp.rm(pdfDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	/** Wrap a web/pdf tool: record successful fetches (the Sources truth
	 *  set) and surface each call as the activity line. */
	function instrument(tool: AgentTool<any>, fetched: Set<string>, setActivity: (line: string) => void): AgentTool<any> {
		return {
			...tool,
			execute: async (callId, input, signal, onUpdate) => {
				const args = input as { url?: string; query?: string; path?: string };
				const what = args.url ?? args.query ?? args.path ?? "";
				setActivity(`${tool.name}${what ? `: ${what.length > 80 ? `${what.slice(0, 79)}…` : what}` : ""}`);
				const result = await tool.execute(callId, input, signal, onUpdate);
				if ((tool.name === "web_fetch" || tool.name === "web_fetch_pdf") && typeof args.url === "string") {
					const text = (result.content ?? [])
						.filter((c): c is { type: "text"; text: string } => (c as { type?: string }).type === "text")
						.map((c) => c.text)
						.join("");
					if (fetchSucceeded(tool.name, text)) fetched.add(normalizeUrl(args.url));
				}
				return result;
			},
		};
	}

	function settle(r: ReadingDiscussionRecord): ReadingDiscussionRecord {
		if (Date.now() - Date.parse(r.updatedAt) < STALE_MS) return r;
		const orphans = discussionThreads(r).flatMap((t) =>
			t.exchanges.filter((x) => (x.status === "queued" || x.status === "answering") && !runs().has(x.id)).map((x) => [t.id, x.id] as const),
		);
		if (orphans.length === 0) return r;
		return (
			discussionStore.mutateDiscussion(r.readingId, (cur) =>
				cur
					? orphans.reduce(
							(acc, [t, x]) => patchExchange(acc, t, x, { status: "error", error: "Interrupted (server restarted)", activity: undefined }),
							cur,
						)
					: null,
			) ?? r
		);
	}

	return {
		start(readingId, threadId, exchangeId) {
			void run(readingId, threadId, exchangeId);
		},
		run,
		abort(exchangeId) {
			const live = runs().get(exchangeId);
			if (!live) return false;
			live.controller.abort();
			return true;
		},
		abortReading(readingId) {
			for (const live of runs().values()) if (live.row.readingId === readingId) live.controller.abort();
		},
		refusal,
		settleIfOrphaned: settle,
	};
}
