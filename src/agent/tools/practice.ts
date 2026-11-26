/**
 * THE PRACTICE TOOLS (Practice v2):
 *   - Pose tools: `problem` (open-ended), `practice_check` (single/multi-select),
 *     `practice_match` (classify/match pairs), and `practice_code` (runnable code).
 *     Every pose ends the turn (`terminate: true`) and commits `modelSolution` up front.
 *   - `conclude`: ends the active problem, reveals the committed `modelSolution`,
 *     and opens the between-problems pause. The turn ends after `conclude` (enforced
 *     by `PracticeGate.concludedThisTurn`, except when `outcome === "voided"` so a
 *     flagged/stepped-down problem can be replaced immediately).
 *   - `practice_summary`: emits the Wrap-up Recap Card (`solid`, `needsPractice`,
 *     `remedialTeach`) with graph-validated node targets.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PracticeSessionMeta } from "../../core/contracts/practice.ts";
import { practiceProblemInputSchema } from "../../core/practice-problems.ts";
import {
	practiceCheckInputProblems,
	practiceCheckInputSchema,
	practiceCodeInputProblems,
	practiceCodeInputSchema,
	practiceMatchInputProblems,
	practiceMatchInputSchema,
} from "../../core/practice-formats.ts";
import { parseOptionsIfString } from "../../core/question-core.ts";
import { resolveTargetId } from "../../core/chains.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { jobTools, type JobToolContext } from "./jobs.ts";
import { proberGraphTools, type GraphToolContext } from "./graph.ts";
import { activeProblemOf, type LhMessage } from "../../core/native-messages.ts";
import { concludeResult, invalidInputResult, problemResult, toToolResult } from "../tool-execute.ts";
import { healEncodedArguments, healToolRecord } from "./heal.ts";
import { figureProblems } from "../subagents/headless.ts";
import type { PracticeVerificationRequest, PracticeVerificationResult } from "../subagents/practice-verifier.ts";

/** The record-reading context the gates and tools need. */
export interface PracticeToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
	/** Whole-graph node list, read fresh per pose/summary. Absent (tests) = no validation. */
	graphNodes?: () => ReadonlyArray<Pick<import("../../core/contracts/graph.ts").GraphNode, "id" | "name">>;
	graph?: GraphToolContext;
	jobs?: JobToolContext;
	/** Active Practice v2 dials for this chat. */
	getPracticeMeta?: () => PracticeSessionMeta;
	/** Optional pre-pose verifier callback (configured when verifySolutions is on). */
	verifyProblem?: (req: PracticeVerificationRequest, signal?: AbortSignal) => Promise<PracticeVerificationResult>;
}

/** Turn-scoped gate state shared across all pose tools and conclude. */
export interface PracticeGate {
	problemActive: boolean;
	concludedThisTurn?: boolean;
	lastConcludeOutcome?: string;
	verificationRetries?: number;
	verifyProblem?: PracticeToolContext["verifyProblem"];
}

/** Seed the turn's gate from the persisted record. */
export function createPracticeGate(ctx: PracticeToolContext): PracticeGate {
	const record = ctx.chatStore.getChat(ctx.chatId);
	return {
		problemActive: record ? activeProblemOf(record.messages) !== null : false,
		concludedThisTurn: false,
		verificationRetries: 0,
		verifyProblem: ctx.verifyProblem,
	};
}

function normalizePoseTargets(
	args: unknown,
	graphNodes?: PracticeToolContext["graphNodes"],
): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const rec = args as Record<string, unknown>;
	const target = rec.target;
	if (!Array.isArray(target) || target.length === 0) {
		return Array.isArray(target) ? { ...rec, target: undefined } : args;
	}
	if (!graphNodes) return args;
	const list = graphNodes();
	const normalized = target.map((t) =>
		typeof t === "string" ? (resolveTargetId(t, list) ?? t) : t,
	);
	if (normalized.every((t, i) => t === target[i])) return args;
	return { ...rec, target: normalized };
}

function checkPoseGate(
	gate: PracticeGate,
	input: { target?: string[] },
	graphNodes: PracticeToolContext["graphNodes"],
	toolName: string,
) {
	if (gate.problemActive) {
		return invalidInputResult(toolName, ["a problem is already active — call conclude on it before posing the next one"]);
	}
	if (gate.concludedThisTurn && gate.lastConcludeOutcome !== "voided") {
		return invalidInputResult(toolName, [
			"a problem was already concluded in this turn — end your turn and wait for the learner's go-ahead",
		]);
	}
	if (graphNodes && input.target?.length) {
		const list = graphNodes();
		const unknown = input.target.filter((target) => resolveTargetId(target, list) === null);
		if (unknown.length) {
			return invalidInputResult(toolName, [
				`target ${JSON.stringify(unknown)} is not a known proposition — targets must be proposition ids from the session context; if the material is not in the map, omit target entirely`,
			]);
		}
	}
	return undefined;
}

/** One synchronous admission for native AND plugin poses; no await can split the gate. */
export function admitPracticeProblem(
	gate: PracticeGate,
	input: { target?: string[] },
	graphNodes?: PracticeToolContext["graphNodes"],
	toolName = "problem",
) {
	const rejected = checkPoseGate(gate, input, graphNodes, toolName);
	if (rejected) return rejected;
	gate.problemActive = true;
	return undefined;
}

async function maybeVerifyAndAdmit(
	gate: PracticeGate,
	input: { target?: string[] },
	graphNodes: PracticeToolContext["graphNodes"],
	toolName: string,
	verifyProblem: PracticeToolContext["verifyProblem"],
	req: PracticeVerificationRequest,
	signal?: AbortSignal,
) {
	const precheck = checkPoseGate(gate, input, graphNodes, toolName);
	if (precheck) return precheck;

	const verify = verifyProblem ?? gate.verifyProblem;
	if (verify && (gate.verificationRetries ?? 0) < 1) {
		const check = await verify(req, signal);
		if (!check.ok) {
			gate.verificationRetries = (gate.verificationRetries ?? 0) + 1;
			return invalidInputResult(toolName, [
				`Pre-pose verification flagged an issue: ${check.issue} Fix the statement or modelSolution and pose again.`,
			]);
		}
	}

	return admitPracticeProblem(gate, input, graphNodes, toolName) ?? problemResult();
}

// ─── problem: open-ended pose ───────────────────────────────────────────────

export const problemInputObject = practiceProblemInputSchema;
export type ProblemInput = Static<typeof problemInputObject>;

export function problemTool(
	gate: PracticeGate,
	graphNodes?: PracticeToolContext["graphNodes"],
	verifyProblem?: PracticeToolContext["verifyProblem"],
): AgentTool<typeof problemInputObject> {
	return {
		name: "problem",
		label: "problem",
		description:
			"Pose one open-ended practice problem. Ends the turn — the learner works in the thinking field; their thinking " +
			"traces and answer commits arrive back as labeled messages. The modelSolution rides this call's " +
			"arguments and stays hidden from the learner until you conclude (conclude shows it verbatim — the " +
			"reveal needs no new field). Only one problem may be active — conclude it before posing the next.",
		parameters: problemInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) =>
			normalizePoseTargets(healEncodedArguments(args, problemInputObject), graphNodes) as never,
		execute: async (_toolCallId, input, signal) =>
			maybeVerifyAndAdmit(
				gate,
				input,
				graphNodes,
				"problem",
				verifyProblem,
				{ toolName: "problem", statement: input.statement, modelSolution: input.modelSolution },
				signal,
			),
	};
}

// ─── practice_check: single/multi-select ────────────────────────────────────

export function practiceCheckTool(
	gate: PracticeGate,
	graphNodes?: PracticeToolContext["graphNodes"],
	verifyProblem?: PracticeToolContext["verifyProblem"],
): AgentTool<typeof practiceCheckInputSchema> {
	return {
		name: "practice_check",
		label: "practice_check",
		description:
			"Pose one quick single-select or multi-select check (ideal for fast recall, picking the right concept, or spotting a broken step). " +
			"Ends the turn. Clean first-try passes conclude automatically; misses stay open under Socratic/Balanced coaching.",
		parameters: practiceCheckInputSchema,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => {
			const healed = healEncodedArguments(args, practiceCheckInputSchema);
			const withOptions =
				healed && typeof healed === "object" && !Array.isArray(healed) && "options" in healed
					? {
							...(healed as Record<string, unknown>),
							options: parseOptionsIfString((healed as { options?: string | unknown[] }).options),
					  }
					: healed;
			return normalizePoseTargets(withOptions, graphNodes) as never;
		},
		execute: async (_toolCallId, input, signal) => {
			const problems = [
				...practiceCheckInputProblems(input),
				...(await figureProblems(input.svg)),
			];
			if (problems.length > 0) return invalidInputResult("practice_check", problems);
			return maybeVerifyAndAdmit(
				gate,
				input,
				graphNodes,
				"practice_check",
				verifyProblem,
				{
					toolName: "practice_check",
					statement: input.statement,
					modelSolution: input.modelSolution,
					options: input.options,
					correctAnswer: input.correctAnswer,
				},
				signal,
			);
		},
	};
}

// ─── practice_match: classify / match pairs ─────────────────────────────────

export function practiceMatchTool(
	gate: PracticeGate,
	graphNodes?: PracticeToolContext["graphNodes"],
	verifyProblem?: PracticeToolContext["verifyProblem"],
): AgentTool<typeof practiceMatchInputSchema> {
	return {
		name: "practice_match",
		label: "practice_match",
		description:
			"Pose one classify/match discrimination demand where the learner maps 2–6 mini-scenarios onto 2–6 competing concepts/categories. " +
			"Ends the turn.",
		parameters: practiceMatchInputSchema,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => {
			const healed = healEncodedArguments(args, practiceMatchInputSchema);
			if (healed && typeof healed === "object" && !Array.isArray(healed)) {
				const rec = { ...(healed as Record<string, unknown>) };
				if ("categories" in rec) rec.categories = parseOptionsIfString(rec.categories as string | unknown[]);
				if ("items" in rec) rec.items = parseOptionsIfString(rec.items as string | unknown[]);
				return normalizePoseTargets(rec, graphNodes) as never;
			}
			return normalizePoseTargets(healed, graphNodes) as never;
		},
		execute: async (_toolCallId, input, signal) => {
			const problems = practiceMatchInputProblems(input);
			if (problems.length > 0) return invalidInputResult("practice_match", problems);
			return maybeVerifyAndAdmit(
				gate,
				input,
				graphNodes,
				"practice_match",
				verifyProblem,
				{
					toolName: "practice_match",
					statement: input.statement,
					modelSolution: input.modelSolution,
					categories: input.categories,
					items: input.items,
					correctMapping: input.correctMapping,
				},
				signal,
			);
		},
	};
}

// ─── practice_code: runnable code practice ──────────────────────────────────

export function practiceCodeTool(
	gate: PracticeGate,
	graphNodes?: PracticeToolContext["graphNodes"],
	verifyProblem?: PracticeToolContext["verifyProblem"],
): AgentTool<typeof practiceCodeInputSchema> {
	return {
		name: "practice_code",
		label: "practice_code",
		description:
			"Pose one runnable code practice problem in python, javascript, typescript, or cpp with optional local test checks. " +
			"Ends the turn.",
		parameters: practiceCodeInputSchema,
		executionMode: "sequential",
		prepareArguments: (args: unknown) =>
			normalizePoseTargets(healEncodedArguments(args, practiceCodeInputSchema), graphNodes) as never,
		execute: async (_toolCallId, input, signal) => {
			const problems = practiceCodeInputProblems(input);
			if (problems.length > 0) return invalidInputResult("practice_code", problems);
			return maybeVerifyAndAdmit(
				gate,
				input,
				graphNodes,
				"practice_code",
				verifyProblem,
				{
					toolName: "practice_code",
					statement: input.statement,
					modelSolution: input.modelSolution,
					language: input.language,
					starterCode: input.starterCode,
					tests: input.tests,
				},
				signal,
			);
		},
	};
}

// ─── conclude: the end of a problem ──────────────────────────────────────────

export const concludeInputObject = Type.Object({
	outcome: Type.Union(
		[
			Type.Literal("solved"),
			Type.Literal("solvedWithHints"),
			Type.Literal("movedOn"),
			Type.Literal("surrendered"),
			Type.Literal("dismissed"),
			Type.Literal("voided"),
		],
		{
			description:
				"REQUIRED — solved, solvedWithHints, movedOn, surrendered, or voided (use voided ONLY when replacing a flagged/bad question or stepping down an unattempted stalled problem; dismissed is system-synthesized).",
		},
	),
	verdict: Type.String({
		description: "REQUIRED — the plain-language verdict: what was credited, where it broke. On a wrong answer: localize the break, do NOT give the correction.",
	}),
	rung: Type.Union(
		[Type.Literal("R0"), Type.Literal("R1"), Type.Literal("R2"), Type.Literal("R3"), Type.Literal("R4"), Type.Literal("R5"), Type.Null()],
		{ description: "REQUIRED — the hint-ladder rung the problem needed: R0 through R5, or null = no hint was given (bare, no quotes)." },
	),
	missClass: Type.Union(
		[
			Type.Literal("cue"),
			Type.Literal("discrimination"),
			Type.Literal("execution"),
			Type.Literal("careless"),
			Type.Literal("structural"),
			Type.Null(),
		],
		{ description: "REQUIRED — the miss classification: cue, discrimination, execution, careless, or structural — or null = no miss (bare, no quotes)." },
	),
	retest: Type.Boolean({ description: "REQUIRED — true marks the problem for a fresh-surface retest before the session ends." }),
});

export type ConcludeInput = Static<typeof concludeInputObject>;

export function concludeTool(gate: PracticeGate): AgentTool<typeof concludeInputObject> {
	return {
		name: "conclude",
		label: "conclude",
		description:
			"Conclude the active problem: records the outcome + verdict, reveals the committed solution, and frees " +
			"the learner's composer. After the result, say your closing words about the learner's work if useful, then " +
			"END YOUR TURN — no further tool calls. The next problem is NEVER posed here: it waits for the learner's " +
			"explicit go-ahead (a *Next problem* message, or their own words asking for the next one). Between problems, " +
			"answer their questions about the concluded one. Only when outcome is `voided` may you immediately pose a " +
			"replacement for a flagged or stepped-down problem. Nothing may conclude unless a problem is active.",
		parameters: concludeInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, concludeInputObject) as never,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			if (!gate.problemActive) {
				return invalidInputResult("conclude", ["no active problem to conclude — pose one first"]);
			}
			gate.problemActive = false;
			gate.concludedThisTurn = true;
			gate.lastConcludeOutcome = input.outcome;
			return concludeResult();
		},
	};
}

// ─── practice_summary: wrap-up recap card ───────────────────────────────────

const summaryItemObject = Type.Object({
	area: Type.String({ minLength: 1, description: "Short topic/concept label." }),
	note: Type.String({ minLength: 1, description: "Concrete observation of what succeeded, remained shaky, or broke." }),
	targets: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Optional graph proposition ids matching the target(s); omit/empty if untagged.",
		}),
	),
});

export const practiceSummaryInputObject = Type.Object({
	summary: Type.String({ minLength: 1, description: "REQUIRED — concise 1–3 sentence overview of the session." }),
	solid: Type.Array(summaryItemObject, { description: "Concepts retrieved cleanly with little or no help." }),
	needsPractice: Type.Array(summaryItemObject, { description: "Shaky or hint-heavy concepts that need more reps." }),
	remedialTeach: Type.Array(summaryItemObject, {
		description: "Concepts where a real misconception or repeated breakdown calls for a remedial Teach session.",
	}),
});

export type PracticeSummaryInput = Static<typeof practiceSummaryInputObject>;

export function practiceSummaryTool(
	gate: PracticeGate,
	graphNodes?: PracticeToolContext["graphNodes"],
): AgentTool<typeof practiceSummaryInputObject> {
	return {
		name: "practice_summary",
		label: "practice_summary",
		description:
			"Wrap up the practice session with a structured recap card grouping targets into solid, needsPractice, and remedialTeach (for misconceptions needing re-teaching). " +
			"Validates any target ids against the knowledge graph without mutating it. Call only when no problem is active.",
		parameters: practiceSummaryInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => healEncodedArguments(args ?? {}, practiceSummaryInputObject) as never,
		execute: async (_toolCallId, input) => {
			if (gate.problemActive) {
				return invalidInputResult("practice_summary", ["conclude the active problem before calling practice_summary"]);
			}
			const list = graphNodes ? graphNodes() : null;
			const normalizeItems = (items: readonly Static<typeof summaryItemObject>[]) => {
				const unknown: string[] = [];
				const normalized = items.map((item) => {
					const targets: string[] = [];
					for (const t of item.targets ?? []) {
						if (!list) {
							targets.push(t);
							continue;
						}
						const resolved = resolveTargetId(t, list);
						if (resolved) targets.push(resolved);
						else unknown.push(t);
					}
					return {
						area: item.area.trim(),
						note: item.note.trim(),
						targets: [...new Set(targets)],
					};
				});
				return { normalized, unknown };
			};

			const solidRes = normalizeItems(input.solid);
			const practiceRes = normalizeItems(input.needsPractice);
			const teachRes = normalizeItems(input.remedialTeach);
			const unknown = [...solidRes.unknown, ...practiceRes.unknown, ...teachRes.unknown];
			if (unknown.length > 0) {
				return invalidInputResult("practice_summary", [
					`unknown proposition target(s) ${JSON.stringify(unknown)} — use exact proposition ids from session context or omit targets`,
				]);
			}
			return toToolResult({
				summary: input.summary.trim(),
				solid: solidRes.normalized,
				needsPractice: practiceRes.normalized,
				remedialTeach: teachRes.normalized,
			});
		},
	};
}

/** The practice toolset (the practice agent's whole registry). */
export function practiceTools(
	ctx: PracticeToolContext,
	gate: PracticeGate = createPracticeGate(ctx),
): Record<string, AgentTool<any>> {
	const jobs = ctx.jobs ? jobTools(ctx.jobs) : null;
	return healToolRecord({
		problem: problemTool(gate, ctx.graphNodes, ctx.verifyProblem),
		practice_check: practiceCheckTool(gate, ctx.graphNodes, ctx.verifyProblem),
		practice_match: practiceMatchTool(gate, ctx.graphNodes, ctx.verifyProblem),
		practice_code: practiceCodeTool(gate, ctx.graphNodes, ctx.verifyProblem),
		conclude: concludeTool(gate),
		practice_summary: practiceSummaryTool(gate, ctx.graphNodes),
		read: readTool,
		ls: lsTool,
		find: findTool,
		grep: grepTool,
		...(jobs?.research ? { research: jobs.research } : {}),
		...(jobs ? { pdf: jobs.pdf! } : {}),
		...(ctx.graph ? proberGraphTools(ctx.graph) : {}),
	});
}
