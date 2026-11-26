/**
 * Practice session contracts — dials, dock actions, wrap-up summary,
 * and Mistakes-seeded practice context.
 * Pure browser-safe types and helpers (zero node:* imports).
 */

export const PRACTICE_COACHING_LEVELS = ["socratic", "balanced", "direct"] as const;
export type PracticeCoachingLevel = (typeof PRACTICE_COACHING_LEVELS)[number];

export const PRACTICE_DEPTHS = ["recall", "adaptive", "deep"] as const;
export type PracticeDepth = (typeof PRACTICE_DEPTHS)[number];

export const PRACTICE_PRESENTATIONS = ["auto", "theory", "applied"] as const;
export type PracticePresentation = (typeof PRACTICE_PRESENTATIONS)[number];

export interface PracticeSessionMeta {
	coaching: PracticeCoachingLevel;
	depth: PracticeDepth;
	presentation: PracticePresentation;
	verifySolutions: boolean;
}

export const DEFAULT_PRACTICE_META: PracticeSessionMeta = {
	coaching: "balanced",
	depth: "adaptive",
	presentation: "auto",
	verifySolutions: false,
};

export function isPracticeCoachingLevel(v: unknown): v is PracticeCoachingLevel {
	return v === "socratic" || v === "balanced" || v === "direct";
}

export function isPracticeDepth(v: unknown): v is PracticeDepth {
	return v === "recall" || v === "adaptive" || v === "deep";
}

export function isPracticePresentation(v: unknown): v is PracticePresentation {
	return v === "auto" || v === "theory" || v === "applied";
}

export function normalizePracticeMeta(
	raw?: Partial<PracticeSessionMeta> | null,
	defaults?: Partial<PracticeSessionMeta> | null,
): PracticeSessionMeta {
	const baseCoaching = isPracticeCoachingLevel(defaults?.coaching)
		? defaults.coaching
		: DEFAULT_PRACTICE_META.coaching;
	const baseDepth = isPracticeDepth(defaults?.depth)
		? defaults.depth
		: DEFAULT_PRACTICE_META.depth;
	const basePresentation = isPracticePresentation(defaults?.presentation)
		? defaults.presentation
		: DEFAULT_PRACTICE_META.presentation;
	const baseVerify = typeof defaults?.verifySolutions === "boolean"
		? defaults.verifySolutions
		: DEFAULT_PRACTICE_META.verifySolutions;

	return {
		coaching: isPracticeCoachingLevel(raw?.coaching) ? raw.coaching : baseCoaching,
		depth: isPracticeDepth(raw?.depth) ? raw.depth : baseDepth,
		presentation: isPracticePresentation(raw?.presentation) ? raw.presentation : basePresentation,
		verifySolutions: typeof raw?.verifySolutions === "boolean" ? raw.verifySolutions : baseVerify,
	};
}

export const PRACTICE_THINKING_ACTIONS = [
	"submit",
	"hint",
	"show-solution",
	"step-down",
	"flag-bad",
] as const;
export type PracticeThinkingAction = (typeof PRACTICE_THINKING_ACTIONS)[number];

export function isPracticeThinkingAction(v: unknown): v is PracticeThinkingAction {
	return typeof v === "string" && (PRACTICE_THINKING_ACTIONS as readonly string[]).includes(v);
}

export interface PracticeSummaryItem {
	area: string;
	note: string;
	targets: string[];
}

export interface PracticeSummaryData {
	summary: string;
	solid: PracticeSummaryItem[];
	needsPractice: PracticeSummaryItem[];
	remedialTeach: PracticeSummaryItem[];
}

export interface MistakeSeedItem {
	id: string;
	question: string;
	errorType?: string;
	topic?: string;
	whatYouDid?: string;
	rule?: string;
	sessionTitle?: string;
}
