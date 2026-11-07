/**
 * ANKI EXPORT — the pure half (browser-safe: no fs, no fetch).
 *
 * The knowledge graph's propositions become Anki flashcards so the learner
 * can keep exercising them between sessions (on a phone through Anki's own
 * AnkiWeb sync). One AnkiNoteRecord per proposition: the card writer's
 * cards for it, plus delivery bookkeeping. Records are written once per
 * node id — re-syncs never regenerate (the cost discipline) and never
 * duplicate (every card carries the node's `lh::<id>` tag, which the
 * AnkiConnect client searches before adding). A rebuild deletes a node's
 * notes and record, then cards it afresh.
 *
 * Cards come in four FORMATS, each its own LearnHarness note type in Anki
 * (created on first delivery, restyled on every sync so CSS changes land):
 * basic, cloze, type-in, and reversed. This module owns the note-type
 * definitions, the AnkiConnect `addNotes` payloads, and the File > Import
 * fallback (which maps onto Anki's built-in note types, since an import
 * file cannot create note types). The network client is
 * src/server/anki-sync.ts.
 */

import type { GraphNode } from "./contracts.ts";

/** Every LearnHarness deck lives under this root (`LearnHarness::<source>`). */
export const ANKI_DECK_ROOT = "LearnHarness";

/** AnkiConnect's documented default listen address. */
export const DEFAULT_ANKICONNECT_URL = "http://127.0.0.1:8765";

/** The demand a card makes (the practice doctrine's modes, one card each):
 *  recall from a fresh situation, the grounds of a conclusion (reverse),
 *  a chain run forward, and the separating feature against a confusable. */
export const ANKI_CARD_KINDS = ["recall", "why", "compose", "discriminate"] as const;
export type AnkiCardKind = (typeof ANKI_CARD_KINDS)[number];

/** How the card is shown in Anki:
 *  - basic    question → answer
 *  - cloze    a sentence with `{{c1::…}}` gaps (front holds the text)
 *  - type     the learner types a short exact answer (a name, date, number)
 *  - reverse  a true two-way pair: two cards, front → back and back → front */
export const ANKI_CARD_FORMATS = ["basic", "cloze", "type", "reverse"] as const;
export type AnkiCardFormat = (typeof ANKI_CARD_FORMATS)[number];

export interface AnkiCard {
	kind: AnkiCardKind;
	/** Absent on records written before formats existed = basic. */
	format?: AnkiCardFormat;
	/** The question; for cloze, the whole sentence with its gaps. */
	front: string;
	/** The answer; empty for cloze. */
	back: string;
	/** One optional line shown after the answer: why it matters, a hook. */
	extra?: string;
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

export const cardFormat = (card: Pick<AnkiCard, "format">): AnkiCardFormat => card.format ?? "basic";

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

/** The deck's own name, without the root ("London Docklands"). */
export function deckTopic(deck: string): string {
	return deck.startsWith(`${ANKI_DECK_ROOT}::`) ? deck.slice(ANKI_DECK_ROOT.length + 2) : deck;
}

/** The dedupe key every card of a node carries. */
export function nodeTag(nodeId: string): string {
	return `lh::${nodeId}`;
}

export function cardTags(record: Pick<AnkiNoteRecord, "nodeId">, card: Pick<AnkiCard, "kind" | "format">): string[] {
	return ["learnharness", nodeTag(record.nodeId), `lh-card::${card.kind}`, `lh-format::${cardFormat(card)}`];
}

/** Plain card text → an Anki HTML field: escape markup, keep line breaks,
 *  turn `**bold**` / `*italic*` into tags, and translate the app's `$…$` /
 *  `$$…$$` math into Anki's MathJax delimiters (`\(…\)` / `\[…\]`). Cloze
 *  markers (`{{c1::…}}`) pass through untouched. */
export function ankiField(text: string): string {
	const escaped = text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
	return escaped
		.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => `\\[${tex}\\]`)
		.replace(/(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$/g, (_m, tex: string) => `\\(${tex}\\)`)
		.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, "<b>$1</b>")
		.replace(/(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g, "<i>$1</i>")
		.replace(/\r?\n/g, "<br>");
}

/** A type-in answer is compared character by character: no markup. */
function plainAnswer(text: string): string {
	return ankiField(text.replace(/\*+/g, "")).replace(/<br>/g, " ");
}

const KIND_LABEL: Record<AnkiCardKind, string> = {
	recall: "Recall",
	why: "Why",
	compose: "Follow the reasoning",
	discriminate: "Tell apart",
};

// ─── the LearnHarness note types ────────────────────────────────────────────

export const ANKI_MODEL_NAMES: Record<AnkiCardFormat, string> = {
	basic: "LearnHarness Basic",
	cloze: "LearnHarness Cloze",
	type: "LearnHarness Type-in",
	reverse: "LearnHarness Reversed",
};

/** Shared card styling: a calm reading card that respects Anki's night mode. */
export const ANKI_CARD_CSS = `.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Helvetica, Arial, sans-serif;
  font-size: 22px;
  line-height: 1.45;
  color: #1f2328;
  background: #fbfaf7;
  text-align: center;
  padding: 24px 16px;
}
.lh-context, .lh-front, .lh-back, .lh-extra, .lh-source, .lh-type { max-width: 32em; margin-left: auto; margin-right: auto; }
.lh-context { font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8a8f98; margin-bottom: 18px; }
.lh-kind { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #ece8df; color: #5b5f66; margin-left: 6px; }
.lh-front { font-size: 24px; font-weight: 500; }
.lh-back { font-size: 30px; font-weight: 700; color: #0b6e4f; margin-top: 6px; }
.lh-extra { font-size: 17px; color: #57606a; margin-top: 18px; }
.lh-source { font-size: 12px; color: #a0a4ab; margin-top: 22px; }
.lh-type { margin-top: 18px; }
.cloze { font-weight: 700; color: #1a6dcc; }
b { font-weight: 700; }
hr#answer { border: none; border-top: 1px solid #e3e1db; margin: 20px auto; max-width: 16em; }
#typeans { font-size: 20px; padding: 6px 10px; border: 1px solid #cfccc4; border-radius: 8px; width: 80%; max-width: 16em; }
.nightMode.card, .night_mode .card { color: #e7e7e4; background: #1d1e21; }
.nightMode .lh-kind, .night_mode .lh-kind { background: #2c2e33; color: #b9bcc2; }
.nightMode .lh-back, .night_mode .lh-back { color: #5fd3a6; }
.nightMode .lh-extra, .night_mode .lh-extra { color: #a7adb5; }
.nightMode .cloze, .night_mode .cloze { color: #7ab8ff; }
.nightMode hr#answer, .night_mode hr#answer { border-top-color: #34363b; }`;

const CONTEXT = `<div class="lh-context">{{Context}}</div>`;
const EXTRA = `{{#Extra}}<div class="lh-extra">{{Extra}}</div>{{/Extra}}`;
const SOURCE = `{{#Source}}<div class="lh-source">{{Source}}</div>{{/Source}}`;
const ANSWER_FIELDS = ["Front", "Back", "Extra", "Context", "Source"];

export interface AnkiModelDefinition {
	modelName: string;
	inOrderFields: string[];
	css: string;
	isCloze: boolean;
	cardTemplates: Array<{ Name: string; Front: string; Back: string }>;
}

/** The four note types, in AnkiConnect `createModel` shape. */
export function ankiModelDefinitions(): AnkiModelDefinition[] {
	const card = (Name: string, question: string, answer: string) => ({
		Name,
		Front: `${CONTEXT}<div class="lh-front">{{${question}}}</div>`,
		Back: `{{FrontSide}}<hr id="answer"><div class="lh-back">{{${answer}}}</div>${EXTRA}${SOURCE}`,
	});
	return [
		{ modelName: ANKI_MODEL_NAMES.basic, inOrderFields: ANSWER_FIELDS, css: ANKI_CARD_CSS, isCloze: false, cardTemplates: [card("Card", "Front", "Back")] },
		{ modelName: ANKI_MODEL_NAMES.reverse, inOrderFields: ANSWER_FIELDS, css: ANKI_CARD_CSS, isCloze: false, cardTemplates: [card("Forward", "Front", "Back"), card("Backward", "Back", "Front")] },
		{
			modelName: ANKI_MODEL_NAMES.type,
			inOrderFields: ANSWER_FIELDS,
			css: ANKI_CARD_CSS,
			isCloze: false,
			cardTemplates: [{
				Name: "Card",
				Front: `${CONTEXT}<div class="lh-front">{{Front}}</div><div class="lh-type">{{type:Back}}</div>`,
				Back: `${CONTEXT}<div class="lh-front">{{Front}}</div><hr id="answer"><div class="lh-type">{{type:Back}}</div>${EXTRA}${SOURCE}`,
			}],
		},
		{
			modelName: ANKI_MODEL_NAMES.cloze,
			inOrderFields: ["Text", "Extra", "Context", "Source"],
			css: ANKI_CARD_CSS,
			isCloze: true,
			cardTemplates: [{
				Name: "Cloze",
				Front: `${CONTEXT}<div class="lh-front">{{cloze:Text}}</div>`,
				Back: `${CONTEXT}<div class="lh-front">{{cloze:Text}}</div>${EXTRA}${SOURCE}`,
			}],
		},
	];
}

// ─── notes ──────────────────────────────────────────────────────────────────

export interface AnkiConnectNote {
	deckName: string;
	modelName: string;
	fields: Record<string, string>;
	tags: string[];
	options: { allowDuplicate: false; duplicateScope: "deck" };
}

function contextField(record: Pick<AnkiNoteRecord, "deck">, card: AnkiCard): string {
	return `${ankiField(deckTopic(record.deck))}<span class="lh-kind">${KIND_LABEL[card.kind]}</span>`;
}

/** One record → its AnkiConnect `addNotes` entries, each in its format's
 *  LearnHarness note type. The proposition's name rides on the answer side
 *  only (on the question it would name the target). */
export function toAnkiConnectNotes(record: AnkiNoteRecord, nodeName: string): AnkiConnectNote[] {
	return record.cards.map((card) => {
		const format = cardFormat(card);
		const shared = { Extra: ankiField(card.extra ?? ""), Context: contextField(record, card), Source: ankiField(nodeName) };
		const fields = format === "cloze"
			? { Text: ankiField(card.front), ...shared }
			: { Front: ankiField(card.front), Back: format === "type" ? plainAnswer(card.back) : ankiField(card.back), ...shared };
		return {
			deckName: record.deck,
			modelName: ANKI_MODEL_NAMES[format],
			fields,
			tags: cardTags(record, card),
			options: { allowDuplicate: false, duplicateScope: "deck" },
		};
	});
}

// ─── the File > Import fallback ─────────────────────────────────────────────

/** An import file cannot create note types, so each format maps onto
 *  Anki's built-in one (two fields each). */
const BUILT_IN_NOTETYPE: Record<AnkiCardFormat, string> = {
	basic: "Basic",
	cloze: "Cloze",
	type: "Basic (type in the answer)",
	reverse: "Basic (and reversed card)",
};

/** A field inside the tab-separated import file: tabs and newlines would
 *  break the row, so they become spaces / <br> (html is on). */
function tsvCell(html: string): string {
	return html.replace(/\t/g, " ").replace(/\r?\n/g, "<br>");
}

/** The File > Import text file: header lines map the note type, deck and
 *  tag columns so Anki needs no import dialog choices. */
export function renderAnkiTsv(records: ReadonlyArray<AnkiNoteRecord>, nodeNames: ReadonlyMap<string, string>): string {
	const lines = ["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:5"];
	for (const record of records) {
		const name = nodeNames.get(record.nodeId) ?? "";
		for (const card of record.cards) {
			const format = cardFormat(card);
			const extra = [card.extra ? ankiField(card.extra) : "", `<small>${ankiField(name)} · ${ankiField(deckTopic(record.deck))}</small>`].filter(Boolean).join("<br><br>");
			const [first, second] = format === "cloze"
				? [ankiField(card.front), extra]
				: format === "type"
					? [ankiField(card.front), plainAnswer(card.back)]
					: [ankiField(card.front), `${ankiField(card.back)}<br><br>${extra}`];
			lines.push([BUILT_IN_NOTETYPE[format], record.deck, first, second, cardTags(record, card).join(" ")].map(tsvCell).join("\t"));
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
