/**
 * THE REVIEW PAYLOAD (GET /api/review, docs/review-plan.md §4.4): the
 * browser-safe wire shape the Review page reads. Types + constants only —
 * the scheduler itself (core/review.ts, ts-fsrs) stays server-side.
 */

import type { ReviewOutcome } from "./review-events.ts";

/** How many due propositions a review session carries by default (owner,
 *  2026-10-23); the page lets the learner adjust the selection. */
export const REVIEW_SESSION_SIZE = 8;

/** The most propositions one session can carry — mirrors the `.slice(0, 64)`
 *  on the picks in POST /api/chats, so the page never silently loses a pick. */
export const REVIEW_SESSION_MAX = 64;

/** How many reviews a day is meant to hold. The page reports the load
 *  beyond this target; it never hides a due proposition. */
export const REVIEW_DAILY_LIMIT = 20;

/** Days in the workload forecast: today plus the next six. */
export const REVIEW_FORECAST_DAYS = 7;

/** One day of the workload forecast. `daysFromNow` 0 = due now through the
 *  next 24 hours (overdue folds in); 1 = 24–48 hours; and so on. */
export interface ReviewForecastDay {
	daysFromNow: number;
	count: number;
}

/** One proposition on the Review page. Times are epoch ms. */
export interface ReviewItem {
	id: string;
	name: string;
	statement: string;
	/** When recall probability is predicted to reach the target. */
	dueAt: number;
	/** Days for recall probability to fall to the target. */
	stability: number;
	reps: number;
	lapses: number;
	/** A first failure on a well-established node awaits a second look
	 *  (docs/review-plan.md §13): the page marks the row. */
	verifying: boolean;
	/** Repeated forgetting: more review on this node is not the fix — the
	 *  page points back to the teaching instead. */
	leech: boolean;
	/** The last countable evidence event's outcome, for the why-due line. */
	lastOutcome: ReviewOutcome | null;
	/** When that event happened (epoch ms); null = no events. */
	lastAttemptAt: number | null;
}

export interface ReviewPayload {
	/** Server clock at derivation (epoch ms) — the page measures "overdue by"
	 *  against it, not its own clock. */
	now: number;
	/** dueAt ≤ now, most overdue first. */
	due: ReviewItem[];
	/** Not yet due, soonest first. */
	upcoming: ReviewItem[];
	/** The default selection size for "Start review". */
	sessionSize: number;
	/** Tomorrow's workload across the next seven days, day granularity. */
	forecast: ReviewForecastDay[];
	/** How many reviews a day is meant to hold; informational, never a cap. */
	dailyLimit: number;
}
