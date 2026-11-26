/**
 * Practice v2 multi-format problem contracts + pure deterministic graders:
 *   - practice_check: Single-select & Multi-select quick checks
 *   - practice_match: Classify / Match scenario pairs onto competing concepts
 *   - practice_code:  Runnable code practice (Python, JS, TS, C++)
 *
 * Pure & browser-safe (zero node:* imports).
 */

import { Type, type Static } from "typebox";
import { CODE_LANGUAGES, type CodeLanguage } from "./code-exercise.ts";
import {
	coerceCorrectAnswer,
	FIGURE_MAX_CHARS,
	normalizeOptions,
	quizInputProblems,
} from "./question-core.ts";
import { repairMathForDisplay } from "./math-delims.ts";

const practiceModeField = Type.Union(
	[Type.Literal("recall"), Type.Literal("discrimination"), Type.Literal("composition")],
	{ description: "REQUIRED — the demand mode: recall, discrimination, or composition (bare words, no quotes)." },
);

const practiceTargetField = Type.Optional(
	Type.Array(Type.String(), {
		minItems: 1,
		description:
			"The proposition id(s) this problem exercises, from the session context's [id] list — include when " +
			"the material is in the map; OMIT entirely when it is not. Names normalize to ids at the seam.",
	}),
);

// ─── 1. practice_check (Single/Multi-select) ────────────────────────────────

export const practiceCheckInputSchema = Type.Object({
	statement: Type.String({
		description: "REQUIRED — the question stem as the learner sees it (markdown + LaTeX). Never announces the target.",
	}),
	mode: practiceModeField,
	target: practiceTargetField,
	options: Type.Array(
		Type.Object({
			label: Type.String({ description: "Display label for the option — a bare claim, no hints or leakage." }),
			value: Type.Optional(Type.String({ description: "Optional stable key; defaults to label." })),
		}),
		{ minItems: 2, description: "REQUIRED — answer options (at least 2)." },
	),
	multiSelect: Type.Optional(
		Type.Boolean({ description: "Set true when multiple options are correct and all must be chosen." }),
	),
	modelSolution: Type.String({
		description: "REQUIRED — concise explanation/derivation committed before posing, revealed on conclude.",
	}),
	correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
		description: "REQUIRED — exact value (or label) of the correct option(s). Array when multiSelect is true.",
	}),
	svg: Type.Optional(
		Type.String({
			description: `Optional inline <svg>…</svg> figure (max ${FIGURE_MAX_CHARS} chars, explicit width/height/viewBox).`,
		}),
	),
});

export type PracticeCheckInput = Static<typeof practiceCheckInputSchema>;

export function practiceCheckInputProblems(input: {
	statement: string;
	modelSolution: string;
	options: Array<{ label: string; value?: string }>;
	correctAnswer: string | string[];
	multiSelect?: boolean;
}): string[] {
	const problems: string[] = [];
	if (input.statement.trim().length === 0) problems.push("statement is empty.");
	if (input.modelSolution.trim().length === 0) problems.push("modelSolution is empty.");
	problems.push(...quizInputProblems(input));
	return problems;
}

export function repairPracticeCheckDisplay(input: PracticeCheckInput): PracticeCheckInput {
	return {
		...input,
		statement: repairMathForDisplay(input.statement),
		modelSolution: repairMathForDisplay(input.modelSolution),
		options: input.options.map((o) => ({ ...o, label: repairMathForDisplay(o.label) })),
	};
}

export interface PracticeCheckGrade {
	correct: boolean;
	expectedValues: string[];
	missedValues: string[];
	extraValues: string[];
}

export function gradePracticeCheck(
	input: Pick<PracticeCheckInput, "options" | "correctAnswer">,
	selectedValues: readonly string[],
): PracticeCheckGrade {
	const normalized = normalizeOptions(input.options);
	const keys = normalized.map((o) => o.value);
	const expectedValues = [...new Set(coerceCorrectAnswer(input.correctAnswer, keys))];
	const expectedSet = new Set(expectedValues);
	const selectedSet = new Set(selectedValues);
	const missedValues = expectedValues.filter((v) => !selectedSet.has(v));
	const extraValues = [...selectedSet].filter((v) => !expectedSet.has(v));
	return {
		correct: missedValues.length === 0 && extraValues.length === 0 && expectedValues.length > 0,
		expectedValues,
		missedValues,
		extraValues,
	};
}

// ─── 2. practice_match (Classify / Match pairs) ─────────────────────────────

export const practiceMatchInputSchema = Type.Object({
	statement: Type.String({
		description: "REQUIRED — concise instruction for classifying/matching the items onto categories.",
	}),
	mode: practiceModeField,
	target: practiceTargetField,
	categories: Type.Array(
		Type.Object({
			id: Type.String({ description: "Short unique category key (e.g. 'cat_a')." }),
			label: Type.String({ description: "Display label for the competing concept/rule." }),
		}),
		{ minItems: 2, maxItems: 6, description: "REQUIRED — 2 to 6 competing concepts/categories." },
	),
	items: Type.Array(
		Type.Object({
			id: Type.String({ description: "Short unique item key (e.g. 'item_1')." }),
			prompt: Type.String({ description: "Mini-scenario or example to classify (markdown + LaTeX)." }),
		}),
		{ minItems: 2, maxItems: 6, description: "REQUIRED — 2 to 6 scenarios/items to match." },
	),
	modelSolution: Type.String({
		description: "REQUIRED — explanation of why each item belongs to its category, committed before posing.",
	}),
	correctMapping: Type.Record(Type.String(), Type.String(), {
		description: "REQUIRED — map of each item.id → the matching category.id.",
	}),
});

export type PracticeMatchInput = Static<typeof practiceMatchInputSchema>;

export function practiceMatchInputProblems(input: PracticeMatchInput): string[] {
	const problems: string[] = [];
	if (input.statement.trim().length === 0) problems.push("statement is empty.");
	if (input.modelSolution.trim().length === 0) problems.push("modelSolution is empty.");

	const catIds = new Set<string>();
	input.categories.forEach((c, i) => {
		const id = c.id.trim();
		const label = c.label.trim();
		if (!id) problems.push(`categories[${i}].id is empty.`);
		else if (catIds.has(id)) problems.push(`duplicate category id "${id}".`);
		else catIds.add(id);
		if (!label) problems.push(`categories[${i}].label is empty.`);
	});

	const itemIds = new Set<string>();
	input.items.forEach((it, i) => {
		const id = it.id.trim();
		const prompt = it.prompt.trim();
		if (!id) problems.push(`items[${i}].id is empty.`);
		else if (itemIds.has(id)) problems.push(`duplicate item id "${id}".`);
		else itemIds.add(id);
		if (!prompt) problems.push(`items[${i}].prompt is empty.`);
	});

	for (const id of itemIds) {
		const mapped = input.correctMapping?.[id];
		if (typeof mapped !== "string" || !catIds.has(mapped.trim())) {
			problems.push(`correctMapping["${id}"] must reference a valid category id (${[...catIds].join(", ")}).`);
		}
	}
	return problems;
}

export function repairPracticeMatchDisplay(input: PracticeMatchInput): PracticeMatchInput {
	return {
		...input,
		statement: repairMathForDisplay(input.statement),
		modelSolution: repairMathForDisplay(input.modelSolution),
		categories: input.categories.map((c) => ({ ...c, label: repairMathForDisplay(c.label) })),
		items: input.items.map((it) => ({ ...it, prompt: repairMathForDisplay(it.prompt) })),
	};
}

export interface PracticeMatchGrade {
	correct: boolean;
	perItem: Record<string, boolean>;
	score: { right: number; total: number };
}

export function gradePracticeMatch(
	input: Pick<PracticeMatchInput, "items" | "correctMapping">,
	mapping: Readonly<Record<string, string>>,
): PracticeMatchGrade {
	const perItem: Record<string, boolean> = {};
	let right = 0;
	for (const item of input.items) {
		const expected = input.correctMapping[item.id]?.trim();
		const actual = mapping[item.id]?.trim();
		const ok = Boolean(expected && actual && expected === actual);
		perItem[item.id] = ok;
		if (ok) right += 1;
	}
	return {
		correct: input.items.length > 0 && right === input.items.length,
		perItem,
		score: { right, total: input.items.length },
	};
}

// ─── 3. practice_code (Runnable Code Practice) ──────────────────────────────

const practiceCodeLanguage = Type.Union(
	[Type.Literal("python"), Type.Literal("javascript"), Type.Literal("typescript"), Type.Literal("cpp")],
	{
		description: `REQUIRED — language as a bare word (no quotes): ${CODE_LANGUAGES.join(", ")}.`,
	},
);

export const practiceCodeInputSchema = Type.Object({
	statement: Type.String({
		description: "REQUIRED — the coding problem statement (markdown + LaTeX).",
	}),
	mode: practiceModeField,
	target: practiceTargetField,
	language: practiceCodeLanguage,
	starterCode: Type.String({
		description: "Starter code in the editor (may be empty for write-from-scratch).",
	}),
	modelSolution: Type.String({
		description: "REQUIRED — reference solution + explanation committed before posing, revealed on conclude.",
	}),
	tests: Type.Optional(
		Type.String({
			description: "Optional assertion/test suite run after learner's code in the same namespace.",
		}),
	),
});

export type PracticeCodeInput = Static<typeof practiceCodeInputSchema> & { language: CodeLanguage };

export function practiceCodeInputProblems(input: {
	statement: string;
	modelSolution: string;
	tests?: string;
}): string[] {
	const problems: string[] = [];
	if (input.statement.trim().length === 0) problems.push("statement is empty.");
	if (input.modelSolution.trim().length === 0) problems.push("modelSolution is empty.");
	if (input.tests !== undefined && input.tests.trim().length === 0) {
		problems.push("tests is blank — omit the field for run-only code practice, or provide checks.");
	}
	return problems;
}

export function repairPracticeCodeDisplay(input: PracticeCodeInput): PracticeCodeInput {
	return {
		...input,
		statement: repairMathForDisplay(input.statement),
		modelSolution: repairMathForDisplay(input.modelSolution),
	};
}
