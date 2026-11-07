/**
 * The tidier (fork, 2026-11-07) — one model pass over the whole graph that
 * PROPOSES changes (core/graph-tidy.ts): merges the auditor missed, splits
 * of bundled ideas, and connections across topics. A single-submit worker
 * (submit-agent.ts); it never writes — the learner accepts each proposal.
 */

import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { GraphChain, GraphNode } from "../../core/contracts.ts";
import { tidyProblem, type TidyChange } from "../../core/graph-tidy.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/** The most propositions one pass reads (the newest win past it). */
export const TIDY_MAX_NODES = 600;

export const TIDIER_INSTRUCTIONS = `You tidy a learner's knowledge graph. The graph holds true ideas ("propositions"), grouped
below by the topic (lesson or notes) they came from, plus reasoning chains: premises that jointly entail a
conclusion. The learner values one thing above all: how different topics CONNECT, so that knowing one
flows naturally into another. Propose changes; the learner accepts or skips each one.

Three kinds of change:

MERGE: two ideas say the SAME thing in different words (often from different topics). Keep the clearer,
better-established one. Merge only true equivalents. Two ideas that are merely related, or where one is
broader than the other, are NOT a merge: connect them instead, or split the broader one.

SPLIT: one idea bundles separate facts that should stand alone ("Slavery was abolished in 1834 AND
owners were compensated £20 million"). Give each part as its own precise idea. Split only when the parts
are genuinely separate facts that other topics could link to; do not split a single idea into
paraphrases.

CONNECT: the heart of this task. Work through every pair of topics and look for what they share: the
same people, families, places, institutions, laws, money, trade goods, periods and events. Where two
topics meet on one of these, there is usually a connection to draw. Find ideas from DIFFERENT topics
that together entail something, or that one entails in another topic. A connection is a chain: premises (existing ids, from at least two
topics between premises and conclusion) and EITHER an existing conclusion id OR a new bridge idea that
follows from the premises. A bridge idea must be TRUE and must follow from its premises; it is the
interesting link a thoughtful reader would draw ("Compensation paid to slave-owners in 1834 flowed to the
same West India merchants who had built the West India Docks"). Never invent facts the premises do not
support; never connect ideas merely because they share a theme or a word.

Every connection must be true and earned, but do not stop at the first one: when topics share a
subject, find each distinct link (up to 12 connections, 10 merges, 10 splits). An empty list is fine
only when the topics truly share nothing. Each change carries a one-line reason written for the learner. Use ids verbatim. Submit all
changes in one submit_tidy call.`;

const ideaSchema = Type.Object({
	name: Type.String({ description: "A very short label, like a glossary headword." }),
	statement: Type.String({ description: "One true, self-contained idea at full precision." }),
});

const submitSchema = Type.Object({
	merges: Type.Array(Type.Object({
		keep: Type.String({ description: "The id to keep." }),
		drop: Type.String({ description: "The id that says the same thing; it folds into keep." }),
		reason: Type.String(),
	}), { maxItems: 10 }),
	splits: Type.Array(Type.Object({
		id: Type.String({ description: "The bundled idea's id." }),
		parts: Type.Array(ideaSchema, { minItems: 2, maxItems: 4 }),
		reason: Type.String(),
	}), { maxItems: 10 }),
	connections: Type.Array(Type.Object({
		premises: Type.Array(Type.String(), { minItems: 1, maxItems: 4, description: "Existing ids, used jointly." }),
		conclusion: Type.Optional(Type.String({ description: "An existing id the premises entail. Omit when giving newIdea." })),
		newIdea: Type.Optional(ideaSchema),
		reason: Type.String(),
	}), { maxItems: 12 }),
});

type TidySubmit = Static<typeof submitSchema>;

export interface TidierProposal {
	change: TidyChange;
	reason: string;
}

/** The prompt: every topic's ideas, then the chains in compact form. */
export function tidierPrompt(nodes: ReadonlyArray<GraphNode>, chains: ReadonlyArray<GraphChain>, topicTitle: (sourceId: string) => string): string {
	const byTopic = new Map<string, GraphNode[]>();
	for (const node of nodes) {
		const topic = node.provenance[0]?.chatId ?? "";
		byTopic.set(topic, [...(byTopic.get(topic) ?? []), node]);
	}
	const ids = new Set(nodes.map((n) => n.id));
	const sections = [...byTopic].map(([topic, members]) =>
		`## Topic: ${topicTitle(topic)}\n${members.map((n) => `[${n.id}] ${n.name}: ${n.statement}`).join("\n")}`);
	const chainLines = chains
		.filter((c) => ids.has(c.conclusion) && c.premises.every((p) => ids.has(p)))
		.map((c) => `${c.premises.join(" + ")} => ${c.conclusion}`);
	return `PROPOSITIONS\n\n${sections.join("\n\n")}\n\nCHAINS\n${chainLines.join("\n") || "(none)"}`;
}

/** Turn the submit into proposals, dropping (not refusing) any change that
 *  fails the apply law — a weak model's one bad id costs that change only. */
export function tidierProposals(value: TidySubmit, nodes: ReadonlyMap<string, GraphNode>, chains: ReadonlyArray<GraphChain>): TidierProposal[] {
	const out: TidierProposal[] = [];
	const push = (change: TidyChange, reason: string) => {
		if (tidyProblem(change, nodes, chains) === null) out.push({ change, reason: reason.trim() });
	};
	for (const m of value.merges) push({ kind: "merge", keep: m.keep, drop: m.drop }, m.reason);
	for (const s of value.splits) push({ kind: "split", node: s.id, parts: s.parts }, s.reason);
	for (const c of value.connections) {
		push({
			kind: "connect",
			premises: c.premises,
			...(c.conclusion ? { conclusion: c.conclusion } : {}),
			...(!c.conclusion && c.newIdea ? { newIdea: c.newIdea } : {}),
		}, c.reason);
	}
	// One proposal per dropped node: a node folds into one keeper.
	const dropped = new Set<string>();
	return out.filter((p) => {
		if (p.change.kind !== "merge") return true;
		if (dropped.has(p.change.drop) || dropped.has(p.change.keep)) return false;
		dropped.add(p.change.drop);
		return true;
	});
}

export async function runTidier(opts: {
	engine: PiEngine | undefined;
	nodes: ReadonlyArray<GraphNode>;
	chains: ReadonlyArray<GraphChain>;
	topicTitle: (sourceId: string) => string;
	signal?: AbortSignal;
	onStep?: (usage: Usage, model: string) => void;
}): Promise<TidierProposal[]> {
	const nodes = [...opts.nodes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, TIDY_MAX_NODES);
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const submitted = await runSubmitAgent<TidySubmit>({
		role: "tidier",
		toolName: "submit_tidy",
		toolDescription: "Submit the proposed merges, splits and connections.",
		parameters: submitSchema,
		fill: (input: Partial<TidySubmit>) => ({ merges: input.merges ?? [], splits: input.splits ?? [], connections: input.connections ?? [] }),
		validate: (value) => {
			for (const id of [
				...value.merges.flatMap((m) => [m.keep, m.drop]),
				...value.splits.map((s) => s.id),
				...value.connections.flatMap((c) => [...c.premises, ...(c.conclusion ? [c.conclusion] : [])]),
			]) {
				if (!byId.has(id)) return `unknown id "${id}" — use ids from the prompt verbatim`;
			}
			const dangling = value.connections.find((c) => !c.conclusion && !c.newIdea);
			if (dangling) return "every connection needs a conclusion id or a newIdea";
			return null;
		},
		systemPrompt: TIDIER_INSTRUCTIONS,
		prompt: tidierPrompt(nodes, opts.chains, opts.topicTitle),
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onStep?.(usage, model),
		neverSubmitted: "the tidier never submitted",
	});
	return tidierProposals(submitted, byId, opts.chains);
}
