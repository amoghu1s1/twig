/**
 * Reading discussions — the pure core (docs/readings.md §14). Browser-safe:
 * no IO, no node builtins. Owns:
 *
 * - ask validation (the route's 400s),
 * - the answer's citations, derived from the run's fetch log (a streamed
 *   answer is visible before it can be validated, so instead of a retry
 *   the server lists only fetched sources and marks the rest unverified),
 * - where a passage thread renders (its block, or the side chat),
 * - the teacher's marker (model-facing text, single-sourced here),
 * - the markdown export's "Discussion" section.
 */

import type { LhMarkerMessage } from "./native-messages.ts";
import type { ReadingKind, ReadingMode, ReadingSource } from "./contracts/readings.ts";
import { isReadingMode, READING_KIND_LABEL } from "./contracts/readings.ts";
import {
	SIDE_THREAD_ID,
	type DiscussionAsk,
	type DiscussionExchange,
	type DiscussionThread,
	type ReadingDiscussionMarkerDetails,
	type ReadingDiscussionRecord,
} from "./contracts/reading-discussions.ts";
import { MAX_PASSAGE_CHARS, normalizeUrl, urlsInText } from "./readings.ts";

export const MAX_QUESTION_CHARS = 4_000;
/** The answer as the teacher's marker carries it (the rest is trimmed). */
export const MARKER_ANSWER_CHARS = 6_000;

// ─── ask validation ─────────────────────────────────────────────────────────

/** Normalize + validate a POST body. A passage starts a new thread; a
 *  threadId continues one; neither asks in the side chat. */
export function parseDiscussionAsk(body: unknown): { ok: true; value: DiscussionAsk } | { ok: false; error: string } {
	if (typeof body !== "object" || body === null) return { ok: false, error: "Body must be a JSON object" };
	const b = body as Record<string, unknown>;
	const str = (v: unknown, max: number): string | undefined => {
		if (typeof v !== "string") return undefined;
		const t = v.trim();
		return t ? t.slice(0, max) : undefined;
	};
	const question = str(b.question, MAX_QUESTION_CHARS);
	if (!question) return { ok: false, error: "question is required" };
	if (!isReadingMode(b.mode)) return { ok: false, error: "mode must be researched or model" };
	const value: DiscussionAsk = { question, mode: b.mode };
	const threadId = str(b.threadId, 200);
	const passage = typeof b.passage === "string" ? b.passage.replace(/\s+/g, " ").trim().slice(0, MAX_PASSAGE_CHARS) : "";
	if (threadId && passage) return { ok: false, error: "Give a threadId (continue) or a passage (new thread), not both" };
	if (threadId) value.threadId = threadId;
	if (passage) {
		value.passage = passage;
		const blockKey = str(b.blockKey, 200);
		if (blockKey) value.blockKey = blockKey;
	}
	return { ok: true, value };
}

// ─── citations from the fetch log ───────────────────────────────────────────

/** The label of each markdown link, by normalized URL (first wins). */
function linkLabels(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g)) {
		const key = normalizeUrl(m[2]!);
		if (!out.has(key)) out.set(key, m[1]!.trim());
	}
	return out;
}

/** The answer's citations: Sources = URLs written in the answer that the
 *  run fetched successfully (researched mode); everything else written in
 *  it is unverified. Model mode fetches nothing, so every URL is. */
export function answerCitations(
	answer: string,
	fetched: ReadonlySet<string>,
	mode: ReadingMode,
): { sources: ReadingSource[]; unverifiedUrls: string[] } {
	const labels = linkLabels(answer);
	const sources: ReadingSource[] = [];
	const unverifiedUrls: string[] = [];
	const seen = new Set<string>();
	for (const url of urlsInText(answer)) {
		const key = normalizeUrl(url);
		if (seen.has(key)) continue;
		seen.add(key);
		if (mode === "researched" && fetched.has(key)) sources.push({ title: labels.get(key) ?? url, url });
		else unverifiedUrls.push(url);
	}
	return { sources, unverifiedUrls };
}

/** Render-time: unverified links lose their link. A markdown link keeps
 *  its label plus an "unverified" mark; a bare URL becomes inline code
 *  (never autolinked) plus the mark. Pure; the stored answer is untouched. */
export function markUnverifiedLinks(answer: string, unverifiedUrls: readonly string[]): string {
	if (unverifiedUrls.length === 0) return answer;
	const bad = new Set(unverifiedUrls.map(normalizeUrl));
	const MARK = " *(unverified link)*";
	const linked = answer.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (whole, label: string, url: string) =>
		bad.has(normalizeUrl(url)) ? `${label}${MARK}` : whole,
	);
	// Bare URLs: skip ones still inside a kept markdown link "](url)".
	return linked.replace(/(\]\()?(https?:\/\/[^\s<>"'`)\]]+)/g, (whole, linkOpen: string | undefined, raw: string) => {
		if (linkOpen) return whole;
		const url = raw.replace(/[.,;:!?]+$/, "");
		const tail = raw.slice(url.length);
		return bad.has(normalizeUrl(url)) ? `\`${url}\`${MARK}${tail}` : whole;
	});
}

// ─── placement ──────────────────────────────────────────────────────────────

/** Where each passage thread renders: after its block when that block
 *  rendered, else in the side chat (the owner's fallback). The side
 *  thread itself is not included. */
export function placeThreads<T extends Pick<DiscussionThread, "blockKey">>(
	threads: readonly T[],
	renderedBlocks: ReadonlySet<string>,
): { inline: Map<string, T[]>; fallback: T[] } {
	const inline = new Map<string, T[]>();
	const fallback: T[] = [];
	for (const t of threads) {
		if (t.blockKey && renderedBlocks.has(t.blockKey)) inline.set(t.blockKey, [...(inline.get(t.blockKey) ?? []), t]);
		else fallback.push(t);
	}
	return { inline, fallback };
}

// ─── the teacher's marker ───────────────────────────────────────────────────

/** Deterministic per exchange: re-delivery is idempotent. */
export function discussionMarkerId(exchangeId: string): string {
	return `steer_rdq_${exchangeId}`;
}

function quote(text: string): string {
	return `> ${text.replace(/\n/g, "\n> ")}`;
}

/** What the teacher reads (owner ruling: the question AND the answer). */
export function discussionMarkerText(input: {
	readingTitle: string;
	readingKind: ReadingKind;
	passage?: string;
	question: string;
	answer: string;
}): string {
	const answer =
		input.answer.length > MARKER_ANSWER_CHARS ? `${input.answer.slice(0, MARKER_ANSWER_CHARS)}\n\n[…answer trimmed]` : input.answer;
	const out = [
		`Reading discussion — beside the lesson, not part of it. The learner asked a question in the Discuss panel of the reading “${input.readingTitle}” (${READING_KIND_LABEL[input.readingKind]}); a reading companion answered, not you.`,
	];
	if (input.passage) out.push(`The passage the learner asked about:\n${quote(input.passage)}`);
	out.push(`The learner's question:\n${quote(input.question)}`);
	out.push(`The answer the learner was shown:\n${quote(answer)}`);
	return out.join("\n\n");
}

/** The marker itself (a native custom message, delivered by the steer
 *  registry's no-wake hold — src/server/jobs.ts deliverHeldNote). */
export function buildDiscussionMarker(input: {
	chatId: string;
	readingId: string;
	readingTitle: string;
	readingKind: ReadingKind;
	thread: Pick<DiscussionThread, "id" | "passage">;
	exchange: Pick<DiscussionExchange, "id" | "question" | "answer">;
	now?: number;
}): LhMarkerMessage {
	const details: ReadingDiscussionMarkerDetails = {
		chatId: input.chatId,
		readingId: input.readingId,
		readingTitle: input.readingTitle,
		threadId: input.thread.id,
		exchangeId: input.exchange.id,
	};
	return {
		id: discussionMarkerId(input.exchange.id),
		role: "custom",
		customType: "reading-discussion",
		content: discussionMarkerText({
			readingTitle: input.readingTitle,
			readingKind: input.readingKind,
			...(input.thread.passage ? { passage: input.thread.passage } : {}),
			question: input.exchange.question,
			answer: input.exchange.answer ?? "",
		}),
		display: true,
		details,
		timestamp: input.now ?? Date.now(),
	};
}

// ─── export ─────────────────────────────────────────────────────────────────

function exchangeMarkdown(x: DiscussionExchange): string[] {
	const out = [`**Q:** ${x.question}`];
	if (x.answer?.trim()) {
		const answer = markUnverifiedLinks(x.answer.trim(), x.unverifiedUrls ?? []);
		out.push(`**A${x.mode === "model" ? " (AI only — not source-checked)" : ""}:** ${answer}`);
	} else if (x.status === "error") {
		out.push(`*No answer${x.error ? `: ${x.error}` : ""}.*`);
	}
	if (x.sources && x.sources.length > 0) out.push(`Sources: ${x.sources.map((s) => `[${s.title}](${s.url})`).join(", ")}`);
	return out;
}

/** The "Discussion" section appended to a reading's markdown download
 *  (owner ruling). Empty string when nothing was asked. */
export function discussionMarkdown(r: Pick<ReadingDiscussionRecord, "side" | "threads"> | null | undefined): string {
	if (!r) return "";
	const threads = r.threads.filter((t) => t.exchanges.length > 0);
	if (threads.length === 0 && r.side.exchanges.length === 0) return "";
	const out = ["## Discussion"];
	for (const t of threads) {
		if (t.passage) out.push(quote(t.passage));
		for (const x of t.exchanges) out.push(...exchangeMarkdown(x));
	}
	if (r.side.exchanges.length > 0) {
		out.push("### Side chat");
		for (const x of r.side.exchanges) out.push(...exchangeMarkdown(x));
	}
	return out.join("\n\n") + "\n";
}

/** An empty discussion (nothing asked yet). */
export function emptyDiscussion(readingId: string, now: string): ReadingDiscussionRecord {
	return {
		readingId,
		side: { id: SIDE_THREAD_ID, exchanges: [], createdAt: now },
		threads: [],
		createdAt: now,
		updatedAt: now,
	};
}
