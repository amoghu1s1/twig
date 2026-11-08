/**
 * Reading discussions — "Discuss" on a reading (docs/readings.md §14).
 *
 * The learner asks questions INSIDE a ready reading: by selecting a
 * passage ("Ask about this" → a PASSAGE THREAD shown inline after the
 * block the selection ends in) or in the side chat (the SIDE thread, one
 * running conversation per reading). A companion agent answers each
 * question, streamed, seeing the reading plus that thread's own history.
 *
 * Owner rulings (2026-10-28): answers may go past the lesson (an explicit
 * ask wins over the "deeper, not further" fence); researched answers list
 * only sources the run actually fetched; for session-anchored readings
 * every finished exchange reaches the teacher as a marker (never a wake);
 * nothing here reaches the graph. Stored apart from the reading
 * (data/reading-discussions/<readingId>.json — its own sole writer).
 *
 * Pure types + tiny pure helpers; type-only imports.
 */

import type { JobUsage } from "./jobs.ts";
import type { ReadingMode, ReadingSource } from "./readings.ts";

export type DiscussionExchangeStatus = "queued" | "answering" | "done" | "error";

/** The side chat's fixed thread id (one per reading). */
export const SIDE_THREAD_ID = "side";

/** One question and its answer. */
export interface DiscussionExchange {
	id: string;
	question: string;
	/** The source mode this answer was asked in (the ask box's toggle). */
	mode: ReadingMode;
	status: DiscussionExchangeStatus;
	/** The answer in markdown (final text; partial when stopped). */
	answer?: string;
	/** Researched: fetched URLs the answer links to (server-derived). */
	sources?: ReadingSource[];
	/** URLs the answer links to that the run never fetched — rendered
	 *  unlinked with an "unverified" mark. */
	unverifiedUrls?: string[];
	/** The latest activity line while answering ("web_fetch: …"). */
	activity?: string;
	error?: string;
	usage?: JobUsage;
	askedAt: string;
	answeredAt?: string;
}

/** A passage thread (a quoted passage + its block) or the side thread. */
export interface DiscussionThread {
	id: string;
	/** Passage threads: the selected text. */
	passage?: string;
	/** Passage threads: the rendered block the selection ended in
	 *  ("body:3", "sec:1:2", "term:4"). Unknown at render → side chat. */
	blockKey?: string;
	exchanges: DiscussionExchange[];
	createdAt: string;
}

export interface ReadingDiscussionRecord {
	readingId: string;
	/** The side chat (id SIDE_THREAD_ID). */
	side: DiscussionThread;
	/** Passage threads, oldest first. */
	threads: DiscussionThread[];
	createdAt: string;
	updatedAt: string;
	/** Lazy v1 schema stamp (absence reads as v1). */
	version?: number;
}

/** The record format this build writes and understands. */
export const CURRENT_DISCUSSION_VERSION = 1;

/** POST /api/readings/[id]/discussion body. */
export interface DiscussionAsk {
	question: string;
	mode: ReadingMode;
	/** An existing thread (SIDE_THREAD_ID or a passage thread's id). */
	threadId?: string;
	/** A NEW passage thread: the selected text + its block. */
	passage?: string;
	blockKey?: string;
}

/** The marker's UI payload (the lesson's quiet system line). */
export interface ReadingDiscussionMarkerDetails {
	chatId: string;
	readingId: string;
	readingTitle: string;
	threadId: string;
	exchangeId: string;
}

/** Running = the exchange still owes a terminal state. */
export function exchangeIsLive(x: Pick<DiscussionExchange, "status">): boolean {
	return x.status === "queued" || x.status === "answering";
}

/** Every thread of a record, side first. */
export function discussionThreads(r: Pick<ReadingDiscussionRecord, "side" | "threads">): DiscussionThread[] {
	return [r.side, ...r.threads];
}
