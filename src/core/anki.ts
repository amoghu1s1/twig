/**
 * ANKI EXPORT — the pure half (browser-safe: no fs, no fetch).
 *
 * The knowledge graph's propositions become Anki flashcards so the learner
 * can keep exercising them between sessions (on a phone through Anki's own
 * AnkiWeb sync). One AnkiNoteRecord per proposition: the card writer's
 * cards for it, plus delivery bookkeeping. Records are written once per
 * node id — re-syncs never regenerate (the cost discipline) and never
 * duplicate (every card carries the node's `lh::<id>` tag, which the
 * AnkiConnect client searches before adding).
 *
 * This module owns the shapes and the two wire formats: AnkiConnect
 * `addNotes` payloads and the File > Import text file (Anki ≥ 2.1.55
 * header syntax). The network client is src/server/anki-sync.ts.
 */

import type { GraphNode } from "./contracts.ts";

/** Every LearnHarness deck lives under this root (`LearnHarness::<source>`). */
export const ANKI_DECK_ROOT = "LearnHarness";

/** AnkiConnect's documented default listen address. */
export const DEFAULT_ANKICONNECT_URL = "http://127.0.0.1:8765";

/** The demand types the card writer may produce (the practice doctrine's
 *  modes, shrunk to one card each): recall from a fresh situation, the
 *  grounds of a conclusion (reverse), a chain run forward, and the
 *  separating feature against a confusable. */
export const ANKI_CARD_KINDS = ["recall", "why", "compose", "discriminate"] as const;
export type AnkiCardKind = (typeof ANKI_CARD_KINDS)[number];

export interface AnkiCard {
	kind: AnkiCardKind;
	front: string;
	back: string;
}

/** One proposition's cards and their delivery state (data/anki/cards.json). */
export interface AnkiNoteRecord {
	nodeId: string;
	/** The node's birth source (provenance[0].chatId) at generation time. */
	sourceId: string;
	deck: string;
	cards: AnkiCard[];
	createdAt: string;
	/** Set once Anki holds this node's cards (added now, or found by tag). */
	deliveredAt?: string;
	noteIds?: number[];
}

/** The node's birth source — the same rule the graph's clusters use. */
export function birthSource(node: Pick<GraphNode, "provenance">): string | undefined {
	return node.provenance[0]?.chatId;
}

/** `LearnHarness::<title>`. Anki splits deck names on "::", so a title
 *  containing it would nest; it is flattened to a single colon. */
export function deckName(sourceTitle: string | undefined): string {
	const title = (sourceTitle ?? "").replaceAll("::", ":").replace(/\s+/g, " ").trim();
	return `${ANKI_DECK_ROOT}::${title.length > 0 ? title : "Unsorted"}`;
}

/** The dedupe key every card of a node carries. */
export function nodeTag(nodeId: string): string {
	return `lh::${nodeId}`;
}

export function cardTags(record: Pick<AnkiNoteRecord, "nodeId">, card: Pick<AnkiCard, "kind">): string[] {
	return ["learnharness", nodeTag(record.nodeId), `lh-card::${card.kind}`];
}

/** Plain card text → an Anki HTML field: escape markup, keep line breaks,
 *  and translate the app's `$…$` / `$$…$$` math into Anki's MathJax
 *  delimiters (`\(…\)` / `\[…\]`). */
export function ankiField(text: string): string {
	const escaped = text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	return escaped
		.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => `\\[${tex}\\]`)
		.replace(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_m, tex: string) => `\\(${tex}\\)`)
		.replace(/\r?\n/g, "<br>");
}

/** The back field: the answer, then a small provenance line naming the
 *  proposition, so a card read weeks later still points home. */
export function backField(record: Pick<AnkiNoteRecord, "deck">, card: AnkiCard, nodeName: string): string {
	const source = record.deck.slice(ANKI_DECK_ROOT.length + 2);
	return `${ankiField(card.back)}<br><br><small>${ankiField(nodeName)} · ${ankiField(source)}</small>`;
}

export interface AnkiConnectNote {
	deckName: string;
	modelName: "Basic";
	fields: { Front: string; Back: string };
	tags: string[];
	options: { allowDuplicate: false; duplicateScope: "deck" };
}

/** One record → its AnkiConnect `addNotes` entries. */
export function toAnkiConnectNotes(record: AnkiNoteRecord, nodeName: string): AnkiConnectNote[] {
	return record.cards.map((card) => ({
		deckName: record.deck,
		modelName: "Basic",
		fields: { Front: ankiField(card.front), Back: backField(record, card, nodeName) },
		tags: cardTags(record, card),
		options: { allowDuplicate: false, duplicateScope: "deck" },
	}));
}

/** A field inside the tab-separated import file: tabs and newlines would
 *  break the row, so they become spaces / <br> (html is on). */
function tsvCell(html: string): string {
	return html.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
}

/** The File > Import text file: header lines map the deck and tag
 *  columns so Anki needs no import dialog choices. */
export function renderAnkiTsv(records: ReadonlyArray<AnkiNoteRecord>, nodeNames: ReadonlyMap<string, string>): string {
	const lines = ["#separator:tab", "#html:true", "#notetype:Basic", "#deck column:1", "#tags column:4"];
	for (const record of records) {
		const name = nodeNames.get(record.nodeId) ?? "";
		for (const note of toAnkiConnectNotes(record, name)) {
			lines.push([note.deckName, note.fields.Front, note.fields.Back, note.tags.join(" ")].map(tsvCell).join("\t"));
		}
	}
	return `${lines.join("\n")}\n`;
}

/** Nodes in scope that have no record yet — the only ones that cost a
 *  card-writer call. */
export function nodesNeedingCards(
	nodes: ReadonlyArray<GraphNode>,
	records: ReadonlyMap<string, AnkiNoteRecord>,
): GraphNode[] {
	return nodes.filter((node) => !records.has(node.id));
}

/** Records generated but not yet in Anki, oldest first. */
export function pendingRecords(records: ReadonlyMap<string, AnkiNoteRecord>): AnkiNoteRecord[] {
	return [...records.values()].filter((r) => !r.deliveredAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
