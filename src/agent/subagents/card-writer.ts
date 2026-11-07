/**
 * The card writer — turns graph propositions into Anki flashcards
 * (core/anki.ts). A single-submit worker (submit-agent.ts), the
 * extractor's shape: one prompt carries a batch of propositions with their
 * reasoning-chain neighbourhood, one validated submit carries every card.
 *
 * Doctrine (adapted from the practice prompt, prompts/practice/10-doctrine.md):
 * a card is a small practice demand. The proposition it exercises should be
 * INACTIVE when the card appears and come to mind from the card's situation,
 * so the front never announces its target; and the demand types are the
 * practice modes, one card each.
 */

import { Type, type Static } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { GraphChain, GraphNode } from "../../core/contracts.ts";
import type { AnkiCard } from "../../core/anki.ts";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

/** Propositions per card-writer call: big enough to amortize the prompt,
 *  small enough that a weak model keeps every card careful. */
export const CARD_WRITER_BATCH = 8;

export const CARD_WRITER_INSTRUCTIONS = `You write Anki flashcards for a learning application. Each proposition below is one true idea the
learner was taught; your cards make it come to mind and work later, away from the lesson.

A card is a small practice demand. The idea it exercises must be INACTIVE when the card appears and
come to mind from the card's own situation, so:
- Never announce the target. Prefer a concrete situation that needs the idea over "What is <name>?".
- Never copy the proposition's statement as the question; the situation must be new.
- One idea per card, a precise question with exactly one correct answer, and a short answer (a few
  words, at most one sentence). No lists of more than three items.
- Each card must make sense on its own, months later, to someone who never saw the lesson.

Card kinds, one card of each that applies:
- recall (always): a fresh situation or example where this idea is what applies.
- why (when the proposition is the conclusion of a listed chain): ask why it must hold; the answer
  is the premises of one chain, used together.
- compose (when a listed chain has two or more premises): give the premises, ask what follows.
- discriminate (when a nearby listed idea is easily confused with it): a near-twin case where only
  this idea fits; the answer names it and the separating feature.

Write 2 to 4 cards per proposition; fewer only when the idea is genuinely simple. Use $…$ for inline
math. Submit every proposition's cards in one submit_cards call, keyed by the proposition's id.`;

const cardSchema = Type.Object({
	// Spelled out: a mapped union over ANKI_CARD_KINDS loses its static type.
	kind: Type.Union([Type.Literal("recall"), Type.Literal("why"), Type.Literal("compose"), Type.Literal("discriminate")], { description: "The demand type." }),
	front: Type.String({ description: "The question side." }),
	back: Type.String({ description: "The answer side: short, at most one sentence." }),
});

const submitSchema = Type.Object({
	propositions: Type.Array(
		Type.Object({
			id: Type.String({ description: 'The proposition id from the prompt, verbatim ("n_…").' }),
			cards: Type.Array(cardSchema, { minItems: 1, maxItems: 4 }),
		}),
		{ description: "Every proposition in the prompt, each with its cards." },
	),
});

type CardSubmit = Static<typeof submitSchema>;

/** One proposition's neighbourhood: the chains it concludes and the
 *  chains it serves as a premise for — what the why/compose/discriminate
 *  cards are built from. */
export function propositionContext(node: GraphNode, chains: ReadonlyArray<GraphChain>, byId: ReadonlyMap<string, GraphNode>): string {
	const label = (id: string) => {
		const n = byId.get(id);
		return n ? `${n.name}: ${n.statement}` : id;
	};
	const lines = [`[${node.id}] ${node.name}`, `Statement: ${node.statement}`];
	if (node.aliases.length > 0) lines.push(`Also phrased: ${node.aliases.join(" | ")}`);
	const concluding = chains.filter((c) => c.conclusion === node.id);
	for (const chain of concluding) lines.push(`Follows from (jointly): ${chain.premises.map(label).join(" + ")}`);
	const serving = chains.filter((c) => c.premises.includes(node.id));
	for (const chain of serving) {
		const others = chain.premises.filter((p) => p !== node.id);
		lines.push(`Helps derive: ${label(chain.conclusion)}${others.length ? ` (together with ${others.map(label).join(" + ")})` : ""}`);
	}
	return lines.join("\n");
}

export function cardWriterPrompt(nodes: ReadonlyArray<GraphNode>, chains: ReadonlyArray<GraphChain>, byId: ReadonlyMap<string, GraphNode>): string {
	return `PROPOSITIONS\n\n${nodes.map((n) => propositionContext(n, chains, byId)).join("\n\n")}`;
}

/** Submit-seam law: exactly the batch's ids, each once. */
export function validateCardSubmit(value: CardSubmit, batchIds: ReadonlySet<string>): string | null {
	const seen = new Set<string>();
	for (const entry of value.propositions) {
		if (!batchIds.has(entry.id)) return `unknown proposition id "${entry.id}" — use the ids from the prompt verbatim`;
		if (seen.has(entry.id)) return `proposition "${entry.id}" appears twice — submit each once`;
		seen.add(entry.id);
		if (entry.cards.some((c) => c.front.trim() === "" || c.back.trim() === "")) return `proposition "${entry.id}" has an empty card side`;
	}
	const missing = [...batchIds].filter((id) => !seen.has(id));
	if (missing.length > 0) return `missing cards for: ${missing.join(", ")}`;
	return null;
}

/** Write cards for ONE batch (≤ CARD_WRITER_BATCH nodes). */
export async function writeCards(opts: {
	engine: PiEngine | undefined;
	nodes: ReadonlyArray<GraphNode>;
	chains: ReadonlyArray<GraphChain>;
	byId: ReadonlyMap<string, GraphNode>;
	signal?: AbortSignal;
	onStep?: (usage: Usage, model: string) => void;
}): Promise<Map<string, AnkiCard[]>> {
	const batchIds = new Set(opts.nodes.map((n) => n.id));
	const submitted = await runSubmitAgent<CardSubmit>({
		role: "cardWriter",
		toolName: "submit_cards",
		toolDescription: "Submit the flashcards for every proposition.",
		parameters: submitSchema,
		fill: (input: CardSubmit) => ({ propositions: input.propositions ?? [] }),
		validate: (value) => validateCardSubmit(value, batchIds),
		systemPrompt: CARD_WRITER_INSTRUCTIONS,
		prompt: cardWriterPrompt(opts.nodes, opts.chains, opts.byId),
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onStep?.(usage, model),
		neverSubmitted: "the card writer never submitted cards",
	});
	return new Map(submitted.propositions.map((p) => [p.id, p.cards.map((c) => ({ kind: c.kind, front: c.front.trim(), back: c.back.trim() }))]));
}
