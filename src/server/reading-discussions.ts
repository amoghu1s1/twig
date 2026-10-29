/**
 * Reading discussions — the server composition (docs/readings.md §14).
 * The routes' one seam: ask → exchange (queued) → the companion pipeline,
 * plus get/abort/live-subscribe, the delete cascade, the dock's rows, and
 * the teacher's marker (a HELD NOTE: never a wake — owner ruling).
 * Composition only: the pure parts live in core/reading-discussions.ts,
 * the companion in the agent layer, persistence in the store adapter.
 */

import {
	answerRunStatuses,
	createDiscussionPipeline,
	subscribeAnswer,
	type LiveAnswerListener,
	type LiveAnswerView,
	type RunningAnswer,
} from "../agent/subagents/reading-discussions.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { buildDiscussionMarker, emptyDiscussion } from "../core/reading-discussions.ts";
import {
	discussionThreads,
	exchangeIsLive,
	SIDE_THREAD_ID,
	type DiscussionAsk,
	type DiscussionExchange,
	type DiscussionThread,
	type ReadingDiscussionRecord,
	type ReadingRecord,
} from "../core/contracts.ts";
import { stores } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { searchProvider } from "./search.ts";
import { jobCost } from "./pricing.ts";
import { deliverHeldNote } from "./jobs.ts";

export type { LiveAnswerView, RunningAnswer };

/** The teacher's marker, for a finished exchange on a session-anchored
 *  reading whose (teaching) session still exists. Fire-and-forget: a held
 *  note resolves only when a run carries it. */
function notifyTeacher(reading: ReadingRecord, thread: DiscussionThread, exchange: DiscussionExchange): void {
	const chatId = reading.anchor.chatId;
	if (!chatId || !exchange.answer) return;
	const chat = stores.chatStore.getChat(chatId);
	if (!chat || chat.kind === "practice") return;
	void deliverHeldNote(
		buildDiscussionMarker({
			chatId,
			readingId: reading.id,
			readingTitle: reading.title,
			readingKind: reading.kind,
			thread,
			exchange,
		}),
	).catch(() => {
		/* A deleted session discards the note; nothing else to do. */
	});
}

/** The app's ONE discussion pipeline (the run registry is globalThis-backed). */
export const discussionPipeline = createDiscussionPipeline({
	readingStore: stores.readingStore,
	discussionStore: stores.readingDiscussionStore,
	engineFor: (role) => {
		const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
		return spec ? piEngineForSpec(spec) : undefined;
	},
	providerKeyMissing: (provider, tier) => (providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier])),
	searchProvider,
	onAnswered: notifyTeacher,
});

export class DiscussionRequestError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 409 | 503,
	) {
		super(message);
		this.name = "DiscussionRequestError";
	}
}

function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Ask a question: a new passage thread, a follow-up in a thread, or the
 *  side chat. Throws DiscussionRequestError for the route's 4xx/503. */
export function askDiscussion(readingId: string, ask: DiscussionAsk): { threadId: string; exchangeId: string } {
	const reading = stores.readingStore.getReading(readingId);
	if (!reading) throw new DiscussionRequestError("Unknown reading", 404);
	if (reading.status !== "ready") throw new DiscussionRequestError("Only a finished reading can be discussed", 409);
	const refused = discussionPipeline.refusal();
	if (refused) throw new DiscussionRequestError(refused, 503);

	const now = new Date().toISOString();
	const exchange: DiscussionExchange = { id: newId("dx"), question: ask.question, mode: ask.mode, status: "queued", askedAt: now };
	const threadId = ask.passage ? newId("dt") : (ask.threadId ?? SIDE_THREAD_ID);
	let problem: DiscussionRequestError | null = null;
	stores.readingDiscussionStore.mutateDiscussion(readingId, (cur) => {
		const base = cur ?? emptyDiscussion(readingId, now);
		if (ask.passage) {
			const thread: DiscussionThread = {
				id: threadId,
				passage: ask.passage,
				...(ask.blockKey ? { blockKey: ask.blockKey } : {}),
				exchanges: [exchange],
				createdAt: now,
			};
			return { ...base, threads: [...base.threads, thread] };
		}
		const thread = discussionThreads(base).find((t) => t.id === threadId);
		if (!thread) {
			problem = new DiscussionRequestError("Unknown thread", 404);
			return null;
		}
		if (thread.exchanges.some(exchangeIsLive)) {
			problem = new DiscussionRequestError("This thread is still answering", 409);
			return null;
		}
		const grown = { ...thread, exchanges: [...thread.exchanges, exchange] };
		return threadId === SIDE_THREAD_ID
			? { ...base, side: grown }
			: { ...base, threads: base.threads.map((t) => (t.id === threadId ? grown : t)) };
	});
	if (problem) throw problem;
	discussionPipeline.start(readingId, threadId, exchange.id);
	return { threadId, exchangeId: exchange.id };
}

/** An exchange as the client reads it: plus its read-time cost. */
export type DiscussionExchangeView = DiscussionExchange & { costUsd: number | null };

export type DiscussionView = Omit<ReadingDiscussionRecord, "side" | "threads"> & {
	side: Omit<DiscussionThread, "exchanges"> & { exchanges: DiscussionExchangeView[] };
	threads: Array<Omit<DiscussionThread, "exchanges"> & { exchanges: DiscussionExchangeView[] }>;
};

function withCosts(t: DiscussionThread): Omit<DiscussionThread, "exchanges"> & { exchanges: DiscussionExchangeView[] } {
	return { ...t, exchanges: t.exchanges.map((x) => ({ ...x, costUsd: x.usage ? jobCost({ usage: x.usage }) : null })) };
}

/** The reading's discussion (an empty one when nothing was asked), orphan-
 *  settled, costs joined. Null when the reading itself is unknown. */
export function getDiscussion(readingId: string): DiscussionView | null {
	if (!stores.readingStore.getReading(readingId)) return null;
	const found = stores.readingDiscussionStore.getDiscussion(readingId);
	const r = found ? discussionPipeline.settleIfOrphaned(found) : emptyDiscussion(readingId, new Date().toISOString());
	return { ...r, side: withCosts(r.side), threads: r.threads.map(withCosts) };
}

/** Stop a live answer (the Stop control and the dock's END). */
export function abortDiscussionAnswer(exchangeId: string): { ok: true } | { ok: false; reason: "not_running" } {
	return discussionPipeline.abort(exchangeId) ? { ok: true } : { ok: false, reason: "not_running" };
}

/** The reading's delete cascades here (owner ruling): live answers stop,
 *  the discussion file goes. */
export function deleteDiscussionOf(readingId: string): void {
	discussionPipeline.abortReading(readingId);
	stores.readingDiscussionStore.deleteDiscussion(readingId);
}

/** The live stream's seam: null when no answer is live for the exchange. */
export function subscribeDiscussionAnswer(exchangeId: string, listener: LiveAnswerListener) {
	return subscribeAnswer(exchangeId, listener);
}

/** The activity dock's rows (cost joined). */
export function discussionActivity(): Array<RunningAnswer & { costUsd: number | null }> {
	return answerRunStatuses().map((row) => {
		const d = stores.readingDiscussionStore.getDiscussion(row.readingId);
		const x = d ? discussionThreads(d).flatMap((t) => t.exchanges).find((e) => e.id === row.id) : undefined;
		return { ...row, costUsd: x?.usage ? jobCost({ usage: x.usage }) : null };
	});
}

/**
 * THE LIVE ANSWER STREAM (owner ruling: answers stream token by token).
 * One SSE response per watcher of one exchange: the current view first
 * (a reconnect replays the answer so far), then every update, then
 * {"type":"settled"} and close — the client refetches the record, which
 * holds the final answer. Not live here → settled at once.
 */
export function discussionAnswerResponse(exchangeId: string): Response {
	const encoder = new TextEncoder();
	let teardown: (() => void) | undefined;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let unsubscribe: (() => void) | undefined;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			const stop = () => {
				if (closed) return;
				closed = true;
				unsubscribe?.();
				if (heartbeat) clearInterval(heartbeat);
				try {
					controller.close();
				} catch {
					// already closed by the reader
				}
			};
			const frame = (payload: unknown) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
				} catch {
					stop();
				}
			};
			const sub = subscribeAnswer(exchangeId, (view) => {
				if (view === "settled") {
					frame({ type: "settled" });
					stop();
				} else frame({ type: "view", ...view });
			});
			if (!sub) {
				frame({ type: "settled" });
				stop();
				return;
			}
			unsubscribe = sub.unsubscribe;
			frame({ type: "view", ...sub.view });
			heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(": ping\n\n"));
				} catch {
					stop();
				}
			}, 25_000);
			teardown = stop;
		},
		cancel() {
			teardown?.();
		},
	});
	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
