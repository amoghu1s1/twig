/**
 * REVIEW EVENTS (review plan, docs/review-plan.md §4.1 — option A): the
 * retrieval evidence the scheduler folds, DERIVED from practice-session
 * records and never stored. One event per target proposition of every
 * cleanly-concluded problem; the order and timestamps are the record's.
 *
 * What counts as evidence: `solved`, `solvedWithHints` and `surrendered`.
 * `movedOn` (the learner ended the problem — no proof of retrieval either
 * way) and `dismissed` (system-synthesized) produce NOTHING (owner,
 * 2026-10-23). Untagged problems (no `target`) carry no node-level signal.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	cleanToolCallIds,
	type LhMessage,
} from "./native-messages.ts";

/** The conclude outcomes that are retrieval evidence. */
export type ReviewOutcome = "solved" | "solvedWithHints" | "surrendered";

/** The hint-ladder rung a problem needed (0–5), or null = no hint given. */
export type ReviewRung = 0 | 1 | 2 | 3 | 4 | 5 | null;

/** The agent's classification of a miss (conclude's `missClass`): the first
 *  three are failures of memory, the last two are slips on knowledge the
 *  learner held (docs/review-plan.md §12). */
export type ReviewMissClass = "cue" | "discrimination" | "structural" | "execution" | "careless";

/** One retrieval of one proposition. */
export interface ReviewEvent {
	/** Graph proposition id (canonical — normalized at pose time). */
	nodeId: string;
	/** Epoch ms of the conclude call's toolResult (when the result exists —
	 *  the call completed THEN, not when the assistant stamped the call;
	 *  the assistant message's timestamp is the fallback). */
	at: number;
	outcome: ReviewOutcome;
	rung: ReviewRung;
	/** null = no miss recorded (or an unrecognized value). */
	missClass: ReviewMissClass | null;
	/** How many target ids the paired problem carried (1 for a single
	 *  target): a multi-target miss may concern only SOME of them, so the
	 *  grader treats a multi-target surrender as ambiguous. */
	targetCount: number;
	/** conclude.retest: the problem was marked for a fresh-surface retest
	 *  later in the same session — that retest is the confirming
	 *  observation, so this marked event should defer to it. */
	retest: boolean;
	/** The practice chat the event came from — review rules treat events of
	 *  one session as one sitting (docs/review-plan.md §13). */
	session: string;
}

const EVIDENCE_OUTCOMES: ReadonlySet<string> = new Set(["solved", "solvedWithHints", "surrendered"]);
const MISS_CLASSES: ReadonlySet<string> = new Set(["cue", "discrimination", "structural", "execution", "careless"]);

/** A recognized miss class, else null. */
function parseMissClass(raw: unknown): ReviewMissClass | null {
	return typeof raw === "string" && MISS_CLASSES.has(raw) ? (raw as ReviewMissClass) : null;
}

/** "R0".."R5" → 0..5; anything else (null, absent, malformed) → null. */
function parseRung(raw: unknown): ReviewRung {
	if (typeof raw !== "string") return null;
	const match = /^R([0-5])$/.exec(raw);
	return match ? (Number(match[1]) as ReviewRung) : null;
}

/** The pose's target ids: strings only, deduplicated; [] = untagged. */
function targetIds(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((t): t is string => typeof t === "string" && t.length > 0))];
}

/**
 * Fold one practice session's messages into review events, in record order.
 * A conclude pairs with the NEWEST cleanly-posed problem before it (the
 * same pairing as `problemInputForConclude`); errored or dangling calls
 * never happened (the honest-activation ruling). `session` is the chat id
 * stamped onto every event.
 */
export function reviewEventsFromMessages(messages: readonly LhMessage[], session: string): ReviewEvent[] {
	const clean = cleanToolCallIds(messages);
	// The events' clock is the conclude call's toolResult: a call completes
	// when its result lands, not when the assistant stamped it. (A conclude
	// with NO result at all never emits events — the clean-pairing gate —
	// so the fallback below guards the timestamp-less legacy result.)
	const resultAt = new Map<string, number>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as ToolResultMessage;
		if (typeof result.timestamp === "number") resultAt.set(result.toolCallId, result.timestamp);
	}
	const events: ReviewEvent[] = [];
	let targets: string[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (const block of assistant.content) {
			if (block.type !== "toolCall" || !clean.has(block.id)) continue;
			if (block.name === PRACTICE_PROBLEM_TOOL) {
				targets = targetIds(block.arguments?.target);
				continue;
			}
			if (block.name !== PRACTICE_CONCLUDE_TOOL) continue;
			const outcome = block.arguments?.outcome;
			if (typeof outcome === "string" && EVIDENCE_OUTCOMES.has(outcome)) {
				const rung = parseRung(block.arguments?.rung);
				const missClass = parseMissClass(block.arguments?.missClass);
				const retest = block.arguments?.retest === true;
				const at = resultAt.get(block.id) ?? assistant.timestamp;
				for (const nodeId of targets) {
					events.push({ nodeId, at, outcome: outcome as ReviewOutcome, rung, missClass, targetCount: targets.length, retest, session });
				}
			}
			targets = [];
		}
	}
	return events;
}
