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
learner was taught; your cards make it come to mind and work later, away from the lesson, often on a
phone in a spare minute. Great cards are short, sharp and specific.

A card is a small practice demand. The idea it exercises must be INACTIVE when the card appears and
come to mind from the card's own cues, so:
- Never announce the target. Prefer a concrete cue that needs the idea over "What is <name>?".
- Never copy the proposition's statement as the question; rephrase around a fresh angle.
- One idea per card, exactly one correct answer, and each card makes sense on its own months later.

BREVITY (hard limits):
- Front: one sentence, at most 25 words. Cut set-up; keep only the cue that matters.
- Back: at most 10 words. A name, a number, a phrase. Never a paragraph.
- Extra (optional): one line, at most 20 words, shown after the answer: the reason, a vivid detail,
  or a hook that makes it stick. Leave it empty rather than restate the back.
- Put the one decisive word or phrase in **bold**. Use $…$ for math. No lists longer than three items.

FORMAT, chosen per card for the content:
- cloze: a crisp fact sentence with its key term, name, date or number hidden as {{c1::…}}. Put the
  whole sentence in "front", leave "back" empty. Hide what is worth recalling, never filler words;
  one cloze number per card (c1). Best for definitions, dates, numbers, names in context.
- type: the learner types the answer, so it must be one to three exact words or a number (a name,
  a year, a term). Put the question in "front", the exact answer in "back", no formatting.
- reverse: only for a true two-way pair (a term and its one-line definition, a place and what it was
  known for) where recalling either side from the other is useful. Front = term, back = definition.
- basic: question and answer, for why, how, and situations.
Mix formats across a proposition's cards; do not make every card basic.

Card kinds, one card of each that applies:
- recall (always): a fresh situation, example or cloze where this idea is what applies.
- why (when the proposition is the conclusion of a listed chain): why must it hold? The answer is
  the premises of one chain, compressed to a few words.
- compose (when a listed chain has two or more premises): give the premises, ask what follows.
- discriminate (when a nearby listed idea is easily confused with it): a near-twin case where only
  this idea fits; the answer names it, the extra gives the separating feature.

Write 2 to 4 cards per proposition; fewer only when the idea is genuinely simple. Submit every
proposition's cards in one submit_cards call, keyed by the proposition's id.`;

// Spelled out: a mapped union over the const arrays loses its static type.
const cardSchema = Type.Object({
	kind: Type.Union([Type.Literal("recall"), Type.Literal("why"), Type.Literal("compose"), Type.Literal("discriminate")], { description: "The demand type." }),
	format: Type.Union([Type.Literal("basic"), Type.Literal("cloze"), Type.Literal("type"), Type.Literal("reverse")], { description: "How Anki shows the card." }),
	front: Type.String({ description: "The question (≤ 25 words); for cloze, the whole sentence with its {{c1::…}} gap." }),
	back: Type.String({ description: "The answer (≤ 10 words); empty for cloze; one to three exact words for type." }),
	extra: Type.Optional(Type.String({ description: "Optional one line (≤ 20 words) shown after the answer." })),
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

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** One card's shape law, by format. Limits sit a little above the prompt's
 *  so a near-miss is accepted and only a real wall of text is sent back. */
export function cardProblem(card: CardSubmit["propositions"][number]["cards"][number]): string | null {
	if (card.front.trim() === "") return "a card has an empty front";
	if (words(card.front) > 35) return `front too long (${words(card.front)} words, keep it under 25): "${card.front.slice(0, 60)}…"`;
	if (card.extra && words(card.extra) > 30) return "extra too long — one line, under 20 words";
	if (card.format === "cloze") {
		if (!/\{\{c\d+::[^}]+\}\}/.test(card.front)) return 'a cloze card needs a {{c1::…}} gap in its front';
		return null;
	}
	if (card.back.trim() === "") return "a card has an empty back";
	if (words(card.back) > 15) return `back too long (${words(card.back)} words, keep it under 10): "${card.back.slice(0, 60)}…"`;
	if (card.format === "type" && words(card.back) > 4) return "a type-in answer must be one to three exact words";
	return null;
}

/** Submit-seam law: exactly the batch's ids, each once, every card in shape. */
export function validateCardSubmit(value: CardSubmit, batchIds: ReadonlySet<string>): string | null {
	const seen = new Set<string>();
	for (const entry of value.propositions) {
		if (!batchIds.has(entry.id)) return `unknown proposition id "${entry.id}" — use the ids from the prompt verbatim`;
		if (seen.has(entry.id)) return `proposition "${entry.id}" appears twice — submit each once`;
		seen.add(entry.id);
		for (const card of entry.cards) {
			const problem = cardProblem(card);
			if (problem) return `proposition "${entry.id}": ${problem}`;
		}
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
	return new Map(submitted.propositions.map((p) => [p.id, p.cards.map((c): AnkiCard => ({
		kind: c.kind,
		format: c.format,
		front: c.front.trim(),
		back: c.format === "cloze" ? "" : c.back.trim(),
		...(c.extra?.trim() ? { extra: c.extra.trim() } : {}),
	}))]));
}
