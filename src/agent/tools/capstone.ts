/**
 * THE CAPSTONE TOOLS (capstone sessions, 2026-11-01): the capstone agent's
 * registry — `brief` (record the accepted criteria + project directory),
 * `review` (a checkpoint verdict per criterion, any time), `evaluate` (the
 * final per-criterion verdicts + observations + gap report; callable again
 * on resubmission) and `gap_report` (the no-pitch path: only when no brief
 * exists) — plus the project-scoped read / ls / find / grep.
 *
 * Mechanics-only descriptions (the practice-tool ruling): WHAT to pass and
 * WHAT happens. The method — shaping a pitch without designing it, what a
 * criterion is, evidence-backed verdicts, never saying how to fix — lives in
 * the system prompt (prompts/capstone/).
 *
 * What is ENFORCED here: one brief per session (criteria + directory are
 * locked by the first clean call), the directory must exist, verdicts must
 * cover exactly the brief's criteria, gap_report is refused once a brief
 * exists, and file access is confined to the accepted directory. What is
 * DOCTRINE only: that the learner actually accepted the brief in chat
 * before the brief call.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveTargetId } from "../../core/chains.ts";
import { capstoneBriefOf, type CapstoneBrief } from "../../core/native-messages.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import type { GraphNode } from "../../core/contracts/graph.ts";
import { invalidInputResult } from "../tool-execute.ts";
import { healToolRecord, healEncodedArguments } from "./heal.ts";
import { projectFsTools, resolveProjectRoot } from "./scoped-fs.ts";

/** The record-reading context the gates need (the practice-tools idiom). */
export interface CapstoneToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[]; kind?: string } | null };
	/** The WHOLE-graph node list, read fresh per call — proposition targets
	 *  validate against it. Absent (tests) = no validation. */
	graphNodes?: () => ReadonlyArray<Pick<GraphNode, "id" | "name">>;
}

/** TURN-SCOPED GATE STATE (the practice gate's lesson): seeded once from the
 *  record at construction, flipped by the executes — the intra-turn truth
 *  the stored record cannot hold until the turn settles. */
export interface CapstoneGate {
	brief: CapstoneBrief | null;
	/** The canonical (realpath) project root, once resolved. */
	root: string | null;
}

export function createCapstoneGate(ctx: CapstoneToolContext): CapstoneGate {
	const record = ctx.chatStore.getChat(ctx.chatId);
	return { brief: record ? capstoneBriefOf(record.messages) : null, root: null };
}

// ─── shared schema pieces ────────────────────────────────────────────────────

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

const targetsField = Type.Optional(
	Type.Array(Type.String(), {
		description: "Proposition ids from the session context's [id] list that this item exercises. Omit when none applies.",
	}),
);

const criterionObject = Type.Object({
	id: Type.String({ minLength: 1, description: "Permanent lowercase slug (a-z, 0-9, hyphens/underscores) — verdicts reference it." }),
	text: Type.String({ minLength: 1, description: "The acceptance criterion: an observable property of the finished project, checkable by reading its code." }),
	targets: targetsField,
});

const verdictObject = Type.Object({
	criterion: Type.String({ minLength: 1, description: "A criterion id from the accepted brief." }),
	status: Type.Union([Type.Literal("met"), Type.Literal("partial"), Type.Literal("unmet")], {
		description: "met, partial, or unmet — bare words, no quotes.",
	}),
	evidence: Type.String({ minLength: 1, description: "What in the project's files supports the verdict — cite file paths and line numbers." }),
});

const gapObject = Type.Object({
	area: Type.String({ minLength: 1, description: "The area or concept that proved unready." }),
	note: Type.String({ minLength: 1, description: "What showed it was unready (an observation, not a fix)." }),
	targets: targetsField,
});

/** Normalize nested target lists (names → ids) at the prepareArguments seam
 *  so the record carries canonical ids; unresolvable strings pass through
 *  for execute to reject. Well-formed input is returned untouched. */
function normalizeNestedTargets(
	args: unknown,
	field: "criteria" | "gaps",
	graphNodes: CapstoneToolContext["graphNodes"],
): unknown {
	if (!graphNodes || typeof args !== "object" || args === null) return args;
	const items = (args as Record<string, unknown>)[field];
	if (!Array.isArray(items)) return args;
	const list = graphNodes();
	let changed = false;
	const next = items.map((item) => {
		if (typeof item !== "object" || item === null) return item;
		const targets = (item as { targets?: unknown }).targets;
		if (!Array.isArray(targets)) return item;
		const mapped = targets.map((t) => (typeof t === "string" ? (resolveTargetId(t, list) ?? t) : t));
		if (mapped.every((t, i) => t === targets[i])) return item;
		changed = true;
		return { ...(item as Record<string, unknown>), targets: mapped };
	});
	return changed ? { ...(args as Record<string, unknown>), [field]: next } : args;
}

function unknownTargets(
	items: ReadonlyArray<{ targets?: string[] }>,
	graphNodes: CapstoneToolContext["graphNodes"],
): string[] {
	if (!graphNodes) return [];
	const list = graphNodes();
	const bad = new Set<string>();
	for (const item of items) {
		for (const t of item.targets ?? []) if (resolveTargetId(t, list) === null) bad.add(t);
	}
	return [...bad];
}

const TARGET_REJECTION = (bad: string[]) =>
	`target ${JSON.stringify(bad)} is not a known proposition — targets must be proposition ids from the session context; omit targets where none applies`;

function ack(text: string) {
	return { content: [{ type: "text" as const, text }], details: null };
}

/** The verdict set must cover exactly the brief's criteria, once each. */
function verdictProblems(brief: CapstoneBrief, verdicts: ReadonlyArray<{ criterion: string }>): string[] {
	const problems: string[] = [];
	const known = new Set(brief.criteria.map((c) => c.id));
	const seen = new Set<string>();
	for (const v of verdicts) {
		if (!known.has(v.criterion)) problems.push(`"${v.criterion}" is not a criterion of the accepted brief (criteria: ${[...known].join(", ")})`);
		else if (seen.has(v.criterion)) problems.push(`criterion "${v.criterion}" has more than one verdict`);
		seen.add(v.criterion);
	}
	const missing = [...known].filter((id) => !seen.has(id));
	if (missing.length > 0) problems.push(`no verdict for criteria: ${missing.join(", ")} — every criterion needs one`);
	return problems;
}

// ─── brief ───────────────────────────────────────────────────────────────────

export const briefInputObject = Type.Object({
	title: Type.String({ minLength: 1, description: "REQUIRED — a short name for the project." }),
	directory: Type.String({
		minLength: 1,
		description: "REQUIRED — the directory the learner builds in (absolute, or ~/…). Must exist. File access for the session is confined to it from now on.",
	}),
	criteria: Type.Array(criterionObject, {
		minItems: 1,
		description: "REQUIRED — the acceptance criteria. Locked by this call: a session has exactly one brief.",
	}),
});

export function briefTool(gate: CapstoneGate, graphNodes?: CapstoneToolContext["graphNodes"]): AgentTool<typeof briefInputObject> {
	return {
		name: "brief",
		label: "brief",
		description:
			"Record the accepted project brief: its title, the project directory, and the acceptance criteria. Call it only after the learner has " +
			"accepted the shaped brief and given the directory. Locks the criteria and directory — a session has one brief, so a second call is refused. " +
			"The scoped file tools work as soon as this call succeeds.",
		parameters: briefInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) =>
			normalizeNestedTargets(healEncodedArguments(args, briefInputObject), "criteria", graphNodes) as never,
		execute: async (toolCallId, input) => {
			if (gate.brief) {
				return invalidInputResult("brief", ["a brief is already accepted — its criteria and directory are locked for this session"]);
			}
			const problems: string[] = [];
			const ids = new Set<string>();
			for (const c of input.criteria) {
				if (!SLUG_RE.test(c.id)) problems.push(`criterion id "${c.id}" must be a lowercase slug (a-z, 0-9, hyphens/underscores)`);
				if (ids.has(c.id)) problems.push(`criterion id "${c.id}" is used twice`);
				ids.add(c.id);
			}
			const bad = unknownTargets(input.criteria, graphNodes);
			if (bad.length > 0) problems.push(TARGET_REJECTION(bad));
			let root: string | null = null;
			try {
				root = await resolveProjectRoot(input.directory);
			} catch (e) {
				problems.push(e instanceof Error ? e.message : String(e));
			}
			if (problems.length > 0 || root === null) return invalidInputResult("brief", problems);
			gate.brief = { toolCallId, title: input.title, directory: input.directory, criteria: input.criteria };
			gate.root = root;
			return ack(
				`Brief recorded: "${input.title}" with ${input.criteria.length} criteria (${input.criteria.map((c) => c.id).join(", ")}). ` +
					`Project directory: ${root}. The criteria and directory are now locked; read, ls, find and grep work inside the project.`,
			);
		},
	};
}

// ─── review ──────────────────────────────────────────────────────────────────

export const reviewInputObject = Type.Object({
	verdicts: Type.Array(verdictObject, {
		minItems: 1,
		description: "REQUIRED — one verdict for EVERY criterion of the accepted brief, no more than one each.",
	}),
	summary: Type.String({ minLength: 1, description: "REQUIRED — the state of the project in a few plain sentences. Say what is missing or wrong, never how to fix it." }),
});
export type ReviewInput = Static<typeof reviewInputObject>;

export function reviewTool(gate: CapstoneGate): AgentTool<typeof reviewInputObject> {
	return {
		name: "review",
		label: "review",
		description:
			"Record a checkpoint review of the project as it stands now: a verdict (met / partial / unmet) with file evidence for every criterion " +
			"of the accepted brief, plus a summary. Does not end or close anything — the learner keeps building. Needs an accepted brief.",
		parameters: reviewInputObject,
		prepareArguments: (args: unknown) => healEncodedArguments(args, reviewInputObject) as never,
		executionMode: "sequential",
		execute: async (_id, input) => {
			if (!gate.brief) return invalidInputResult("review", ["no accepted brief yet — record it with the brief tool first"]);
			const problems = verdictProblems(gate.brief, input.verdicts);
			if (problems.length > 0) return invalidInputResult("review", problems);
			return ack("Review recorded. Give the learner your closing words about where the project stands (what is missing or wrong, never how to fix it).");
		},
	};
}

// ─── evaluate ────────────────────────────────────────────────────────────────

export const evaluateInputObject = Type.Object({
	verdicts: Type.Array(verdictObject, {
		minItems: 1,
		description: "REQUIRED — one verdict for EVERY criterion of the accepted brief, no more than one each.",
	}),
	observations: Type.String({ minLength: 1, description: "REQUIRED — quality observations beyond the criteria (structure, correctness, robustness), grounded in the files." }),
	gaps: Type.Array(gapObject, {
		description: "REQUIRED — the gap report: areas that proved unready. An empty list when nothing did.",
	}),
});
export type EvaluateInput = Static<typeof evaluateInputObject>;

export function evaluateTool(gate: CapstoneGate, graphNodes?: CapstoneToolContext["graphNodes"]): AgentTool<typeof evaluateInputObject> {
	return {
		name: "evaluate",
		label: "evaluate",
		description:
			"Record the evaluation of a submitted project: a verdict with file evidence for every criterion, quality observations, and the gap report. " +
			"Callable again when the learner resubmits — the latest evaluation stands, earlier ones stay in the history. Needs an accepted brief.",
		parameters: evaluateInputObject,
		prepareArguments: (args: unknown) =>
			normalizeNestedTargets(healEncodedArguments(args, evaluateInputObject), "gaps", graphNodes) as never,
		executionMode: "sequential",
		execute: async (_id, input) => {
			if (!gate.brief) return invalidInputResult("evaluate", ["no accepted brief yet — record it with the brief tool first"]);
			const problems = verdictProblems(gate.brief, input.verdicts);
			const bad = unknownTargets(input.gaps, graphNodes);
			if (bad.length > 0) problems.push(TARGET_REJECTION(bad));
			if (problems.length > 0) return invalidInputResult("evaluate", problems);
			return ack("Evaluation recorded. Give the learner your closing words about the work; the session stays open for a resubmission.");
		},
	};
}

// ─── gap_report ──────────────────────────────────────────────────────────────

export const gapReportInputObject = Type.Object({
	summary: Type.String({ minLength: 1, description: "REQUIRED — plainly why no capstone can start yet." }),
	gaps: Type.Array(gapObject, { minItems: 1, description: "REQUIRED — the areas/propositions that proved unready." }),
});
export type GapReportInput = Static<typeof gapReportInputObject>;

export function gapReportTool(gate: CapstoneGate, graphNodes?: CapstoneToolContext["graphNodes"]): AgentTool<typeof gapReportInputObject> {
	return {
		name: "gap_report",
		label: "gap_report",
		description:
			"The no-pitch path: when the learner cannot pitch a project that uses the picked material, record a gap report of what proved unready. " +
			"Only available while no brief has been accepted. The learner can then start a teach or practice session seeded from the gaps.",
		parameters: gapReportInputObject,
		prepareArguments: (args: unknown) =>
			normalizeNestedTargets(healEncodedArguments(args, gapReportInputObject), "gaps", graphNodes) as never,
		executionMode: "sequential",
		execute: async (_id, input) => {
			if (gate.brief) return invalidInputResult("gap_report", ["a brief is already accepted — gaps are reported through evaluate"]);
			const bad = unknownTargets(input.gaps, graphNodes);
			if (bad.length > 0) return invalidInputResult("gap_report", [TARGET_REJECTION(bad)]);
			return ack("Gap report recorded. Say plainly that the material is not yet usable for a build, and point the learner to teach or practice.");
		},
	};
}

// ─── the registry ────────────────────────────────────────────────────────────

/** The capstone toolset (the capstone agent's whole registry). */
export function capstoneTools(ctx: CapstoneToolContext): Record<string, AgentTool<any>> {
	const gate = createCapstoneGate(ctx);
	// The root is resolved lazily from the gate: seeded from the record on a
	// later turn, set directly by the brief tool in its own turn.
	const getRoot = async (): Promise<string | null> => {
		if (gate.root) return gate.root;
		if (!gate.brief) return null;
		gate.root = await resolveProjectRoot(gate.brief.directory);
		return gate.root;
	};
	return healToolRecord({
		brief: briefTool(gate, ctx.graphNodes),
		review: reviewTool(gate),
		evaluate: evaluateTool(gate, ctx.graphNodes),
		gap_report: gapReportTool(gate, ctx.graphNodes),
		...projectFsTools(getRoot),
	});
}
