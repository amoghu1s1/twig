/**
 * The graph → Anki channel:
 *
 *   core/anki.ts        deck names, field escaping + math delimiters, the
 *                       AnkiConnect note payload, the File > Import file
 *   store/anki.ts       the cards.json map round-trip (temp file)
 *   card-writer.ts      the submit-seam law (exactly the batch's ids)
 *   anki-sync.ts        scripted card writer + fake AnkiConnect: cards
 *                       persist before delivery, an unreachable Anki
 *                       queues, a later sync delivers, a re-sync never
 *                       re-cards or re-adds, a tag already in Anki is
 *                       marked delivered without adding
 *
 * Ledger: an in-memory graph; this suite never touches data/.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { ankiField, deckName, renderAnkiTsv, toAnkiConnectNotes, type AnkiNoteRecord } from "../src/core/anki.ts";
import { createAnkiStore } from "../src/store/anki.ts";
import { cardProblem, cardWriterPrompt, givesAwayAnswer, validateCardSubmit } from "../src/agent/subagents/card-writer.ts";
import { createAnkiSync, type AnkiConnect } from "../src/server/anki-sync.ts";
import { ModelsNotConfiguredError } from "../src/core/settings.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-anki-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let fileCount = 0;
const freshStore = () => createAnkiStore(path.join(tmp, `cards-${fileCount++}.json`));

function node(id: string, name: string, statement: string, chatId = "chat_a"): GraphNode {
	return { id, name, statement, aliases: [], createdAt: "2026-11-01T00:00:00.000Z", provenance: [{ chatId, messageId: "m1" }] };
}

const NODES = [
	node("n_1", "Opportunity cost", "The cost of a choice is the value of the best alternative given up."),
	node("n_2", "Sunk cost", "Costs already incurred cannot be recovered by any future choice."),
	node("n_3", "Ignore sunk costs", "Rational choices ignore sunk costs."),
];
const CHAINS: GraphChain[] = [
	{ id: "arg_1", premises: ["n_1", "n_2"], conclusion: "n_3", provenance: [{ chatId: "chat_a", messageId: "m1" }], createdAt: "2026-11-01T00:00:00.000Z" },
];

function graphStore(nodes: GraphNode[] = NODES, chains: GraphChain[] = CHAINS) {
	return { readNodes: () => nodes, readChains: () => chains };
}

/** A card writer that answers each call with cards for the ids it is asked about. */
function scriptedWriter(calls: string[][]): PiEngine {
	const faux = createFauxCore({});
	const step: FauxResponseStep = (context) => {
		const prompt = JSON.stringify(context.messages);
		const ids = [...new Set(prompt.match(/n_\d+/g) ?? [])].filter((id) => prompt.includes(`[${id}]`));
		calls.push(ids);
		const input = { propositions: ids.map((id) => ({ id, cards: [{ kind: "recall", format: "cloze", front: `{{c1::${id}}} applies here.`, back: "" }, { kind: "why", format: "basic", front: `Why ${id}?`, back: "Because." }] })) };
		return fauxAssistantMessage([fauxToolCall("submit_cards", input as ToolCall["arguments"], { id: `submit-${calls.length}` })], { stopReason: "toolUse" });
	};
	faux.setResponses([step, step, step, step]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** AnkiConnect fake: in-memory notes; `reachable` flips at will. */
function fakeAnki() {
	const state = { reachable: true, decks: new Set<string>(), notes: [] as Array<{ id: number; deck: string; tags: string[] }>, adds: 0, models: new Set<string>(), restyled: 0 };
	const anki: AnkiConnect = {
		async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
			if (!state.reachable) throw new Error("connection refused");
			switch (action) {
				case "version": return 6 as T;
				case "createDeck": state.decks.add(params.deck as string); return 1 as T;
				case "findNotes": {
					const tag = /tag:([^"]+)/.exec(params.query as string)?.[1];
					return state.notes.filter((n) => n.tags.includes(tag ?? "")).map((n) => n.id) as T;
				}
				case "modelNames": return [...state.models] as T;
				case "createModel": state.models.add(params.modelName as string); return {} as T;
				case "updateModelStyling": case "updateModelTemplates": state.restyled++; return null as T;
				case "deleteNotes": {
					const gone = new Set(params.notes as number[]);
					state.notes = state.notes.filter((n) => !gone.has(n.id));
					return null as T;
				}
				case "addNotes": {
					const notes = params.notes as Array<{ deckName: string; tags: string[]; modelName: string }>;
					for (const n of notes) assert.ok(state.models.has(n.modelName), `note type ${n.modelName} exists before add`);
					state.adds += notes.length;
					return notes.map((n) => {
						const id = 1000 + state.adds + state.notes.length;
						state.notes.push({ id, deck: n.deckName, tags: n.tags });
						return id;
					}) as T;
				}
				default: throw new Error(`unexpected action ${action}`);
			}
		},
	};
	return { anki, state };
}

describe("core/anki", () => {
	it("names decks under the root and flattens nested separators", () => {
		assert.equal(deckName("Microeconomics"), "Twig::Microeconomics");
		assert.equal(deckName("A::B"), "Twig::A:B");
		assert.equal(deckName(undefined), "Twig::Unsorted");
	});

	it("escapes markup, keeps line breaks, and converts math to MathJax", () => {
		assert.equal(ankiField("a < b\nc & d"), "a &lt; b<br>c &amp; d");
		assert.equal(ankiField("area $\\pi r^2$ and $$e^{i\\pi}$$"), "area \\(\\pi r^2\\) and \\[e^{i\\pi}\\]");
		assert.equal(ankiField("costs $5 and $6"), "costs $5 and $6"); // prices are not math
	});

	it("turns **bold** and *italic* into markup", () => {
		assert.equal(ankiField("the **decisive** word, *gently*"), "the <b>decisive</b> word, <i>gently</i>");
		assert.equal(ankiField("2 * 3 * 4"), "2 * 3 * 4");
	});

	it("builds notes on the Twig note type for each format", () => {
		const record: AnkiNoteRecord = {
			nodeId: "n_1", sourceId: "chat_a", deck: "Twig::Econ", createdAt: "x",
			cards: [
				{ kind: "recall", front: "Q", back: "**A**" },
				{ kind: "recall", format: "cloze", front: "The {{c1::opportunity cost}} is the best alternative.", back: "", extra: "Every yes is a no." },
				{ kind: "recall", format: "type", front: "Name it", back: "**Sunk cost**" },
				{ kind: "discriminate", format: "reverse", front: "Term", back: "Definition" },
			],
		};
		const [basic, cloze, type, reverse] = toAnkiConnectNotes(record, "Opportunity cost");
		assert.equal(basic!.deckName, "Twig::Econ");
		assert.equal(basic!.modelName, "Twig Basic");
		assert.deepEqual(basic!.tags, ["twig", "lh::n_1", "lh-card::recall", "lh-format::basic"]);
		assert.equal(basic!.fields.Back, "<b>A</b>");
		assert.equal(basic!.fields.Source, "Opportunity cost");
		assert.match(basic!.fields.Context ?? "", /Econ<span class="lh-kind">Recall<\/span>/);
		assert.equal(basic!.options.allowDuplicate, false);
		assert.equal(cloze!.modelName, "Twig Cloze");
		assert.equal(cloze!.fields.Text, "The {{c1::opportunity cost}} is the best alternative.");
		assert.equal(cloze!.fields.Extra, "Every yes is a no.");
		assert.equal(type!.modelName, "Twig Type-in");
		assert.equal(type!.fields.Back, "Sunk cost"); // typed answers are compared as plain text
		assert.equal(reverse!.modelName, "Twig Reversed");
		assert.match(reverse!.fields.Context ?? "", /Tell apart/);
	});

	it("renders an import file whose header maps note type, deck and tag columns", () => {
		const record: AnkiNoteRecord = {
			nodeId: "n_1", sourceId: "chat_a", deck: "Twig::Econ", createdAt: "x",
			cards: [{ kind: "recall", front: "Q\twith tab", back: "A" }, { kind: "recall", format: "cloze", front: "{{c1::X}} is Y", back: "" }],
		};
		const lines = renderAnkiTsv([record], new Map([["n_1", "Opportunity cost"]])).trimEnd().split("\n");
		assert.deepEqual(lines.slice(0, 5), ["#separator:tab", "#html:true", "#notetype column:1", "#deck column:2", "#tags column:5"]);
		const cells = lines[5]!.split("\t");
		assert.equal(cells.length, 5);
		assert.deepEqual(cells.slice(0, 3), ["Basic", "Twig::Econ", "Q with tab"]);
		assert.equal(cells[4], "twig lh::n_1 lh-card::recall lh-format::basic");
		const clozeCells = lines[6]!.split("\t");
		assert.equal(clozeCells[0], "Cloze");
		assert.equal(clozeCells[2], "{{c1::X}} is Y");
	});
});

describe("store/anki", () => {
	it("round-trips records and skips invalid entries", () => {
		const file = path.join(tmp, "roundtrip.json");
		const store = createAnkiStore(file);
		assert.equal(store.readRecords().size, 0);
		store.upsertRecords([{ nodeId: "n_1", sourceId: "chat_a", deck: "Twig::X", createdAt: "t", cards: [{ kind: "why", format: "basic", front: "Q", back: "A" }] }]);
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		raw.n_bad = { nodeId: "n_bad", cards: "nope" };
		fs.writeFileSync(file, JSON.stringify(raw));
		const records = store.readRecords();
		assert.deepEqual([...records.keys()], ["n_1"]);
		store.upsertRecords([{ ...records.get("n_1")!, deliveredAt: "later", noteIds: [7] }]);
		assert.deepEqual(store.readRecords().get("n_1")?.noteIds, [7]);
	});
});

describe("card writer", () => {
	it("prompts with each proposition's chains", () => {
		const prompt = cardWriterPrompt([NODES[2]!, NODES[0]!], CHAINS, new Map(NODES.map((n) => [n.id, n])));
		assert.match(prompt, /\[n_3\] Ignore sunk costs/);
		assert.match(prompt, /Follows from \(jointly\): Opportunity cost: .* \+ Sunk cost: /);
		assert.match(prompt, /Helps derive: Ignore sunk costs: .*\(together with Sunk cost: /);
	});

	it("accepts exactly the batch's ids", () => {
		const card = { kind: "recall" as const, format: "basic" as const, front: "Q", back: "A" };
		const batch = new Set(["n_1", "n_2"]);
		assert.equal(validateCardSubmit({ propositions: [{ id: "n_1", cards: [card] }, { id: "n_2", cards: [card] }] }, batch), null);
		assert.match(validateCardSubmit({ propositions: [{ id: "n_1", cards: [card] }] }, batch) ?? "", /missing cards for: n_2/);
		assert.match(validateCardSubmit({ propositions: [{ id: "n_9", cards: [card] }] }, batch) ?? "", /unknown proposition id/);
		assert.match(validateCardSubmit({ propositions: [{ id: "n_1", cards: [card] }, { id: "n_1", cards: [card] }, { id: "n_2", cards: [card] }] }, batch) ?? "", /twice/);
		assert.match(validateCardSubmit({ propositions: [{ id: "n_1", cards: [{ ...card, back: " " }] }, { id: "n_2", cards: [card] }] }, batch) ?? "", /empty back/);
	});
});

describe("card shape", () => {
	it("keeps cards short and each format well-formed", () => {
		const long = Array.from({ length: 40 }, () => "word").join(" ");
		assert.equal(cardProblem({ kind: "recall", format: "cloze", front: "The {{c1::answer}} here.", back: "" }), null);
		assert.match(cardProblem({ kind: "recall", format: "cloze", front: "No gap here.", back: "" }) ?? "", /cloze/);
		assert.match(cardProblem({ kind: "recall", format: "basic", front: long, back: "A" }) ?? "", /front too long/);
		assert.match(cardProblem({ kind: "recall", format: "basic", front: "Q", back: long }) ?? "", /back too long/);
		assert.match(cardProblem({ kind: "recall", format: "type", front: "Q", back: "five words in this answer" }) ?? "", /type-in/);
		assert.match(cardProblem({ kind: "recall", format: "basic", front: "Q", back: "A", extra: long }) ?? "", /extra too long/);
	});
});

describe("anki sync", () => {
	it("cards, delivers, and never re-cards or re-adds", async () => {
		const calls: string[][] = [];
		const { anki, state } = fakeAnki();
		const store = freshStore();
		const sync = createAnkiSync({ graphStore: graphStore(), ankiStore: store, sourceTitle: () => "Microeconomics", cardWriter: scriptedWriter(calls), anki });

		const first = await sync.sync();
		assert.deepEqual(first, { carded: 3, added: 6, alreadyInAnki: 0, waiting: 0, ankiReachable: true });
		assert.equal(calls.length, 1);
		assert.deepEqual([...state.decks], ["Twig::Microeconomics"]);
		assert.ok([...store.readRecords().values()].every((r) => r.deliveredAt && r.noteIds?.length === 2));

		const second = await sync.sync();
		assert.deepEqual(second, { carded: 0, added: 0, alreadyInAnki: 0, waiting: 0, ankiReachable: true });
		assert.equal(calls.length, 1);
		assert.equal(state.adds, 6);
	});

	it("queues cards while Anki is unreachable and delivers them later", async () => {
		const { anki, state } = fakeAnki();
		state.reachable = false;
		const store = freshStore();
		const sync = createAnkiSync({ graphStore: graphStore(), ankiStore: store, sourceTitle: () => "Econ", cardWriter: scriptedWriter([]), anki });

		const offline = await sync.sync();
		assert.equal(offline.carded, 3);
		assert.equal(offline.waiting, 3);
		assert.equal(offline.ankiReachable, false);
		assert.match(offline.ankiError ?? "", /connection refused/);
		assert.equal((await sync.status()).waiting, 3);

		state.reachable = true;
		const online = await sync.sync();
		assert.equal(online.carded, 0);
		assert.equal(online.added, 6);
		assert.equal((await sync.status()).waiting, 0);
	});

	it("marks a node already in Anki as delivered without adding", async () => {
		const { anki, state } = fakeAnki();
		state.notes.push({ id: 1, deck: "Twig::Econ", tags: ["twig", "lh::n_1"] });
		const sync = createAnkiSync({ graphStore: graphStore(), ankiStore: freshStore(), sourceTitle: () => "Econ", cardWriter: scriptedWriter([]), anki });
		const result = await sync.sync({ nodeIds: ["n_1", "n_2"] });
		assert.equal(result.carded, 2);
		assert.equal(result.alreadyInAnki, 1);
		assert.equal(result.added, 2);
	});

	it("scopes by birth source", async () => {
		const calls: string[][] = [];
		const nodes = [...NODES, node("n_4", "Other", "Another idea.", "chat_b")];
		const sync = createAnkiSync({ graphStore: graphStore(nodes), ankiStore: freshStore(), sourceTitle: (id) => id, cardWriter: scriptedWriter(calls), anki: fakeAnki().anki });
		const result = await sync.sync({ sourceIds: ["chat_b"] });
		assert.equal(result.carded, 1);
		assert.deepEqual(calls, [["n_4"]]);
		assert.match(sync.importFile(), /Twig::chat_b/);
	});

	it("refuses honestly with no card-writer model", async () => {
		const sync = createAnkiSync({ graphStore: graphStore(), ankiStore: freshStore(), sourceTitle: () => "x", engineFor: () => undefined, anki: fakeAnki().anki });
		await assert.rejects(sync.sync(), ModelsNotConfiguredError);
	});

	it("creates the note types once, then refreshes their styling", async () => {
		const { anki, state } = fakeAnki();
		const sync = createAnkiSync({ graphStore: graphStore(), ankiStore: freshStore(), sourceTitle: () => "Econ", cardWriter: scriptedWriter([]), anki });
		await sync.sync({ nodeIds: ["n_1"] });
		assert.deepEqual([...state.models].sort(), ["Twig Basic", "Twig Cloze", "Twig Reversed", "Twig Type-in"]);
		assert.equal(state.restyled, 0);
		await sync.sync({ nodeIds: ["n_2"] });
		assert.ok(state.restyled > 0);
	});

	it("rebuild deletes the old notes and writes fresh cards", async () => {
		const calls: string[][] = [];
		const { anki, state } = fakeAnki();
		const sync = createAnkiSync({ graphStore: graphStore(), ankiStore: freshStore(), sourceTitle: () => "Econ", cardWriter: scriptedWriter(calls), anki });
		await sync.sync();
		const before = state.notes.map((n) => n.id);
		const result = await sync.rebuild();
		assert.equal(result.removed, 6);
		assert.equal(result.carded, 3);
		assert.equal(result.added, 6);
		assert.equal(calls.length, 2);
		assert.equal(state.notes.length, 6);
		assert.ok(state.notes.every((n) => !before.includes(n.id)));
	});

	it("rebuild refuses while Anki is closed and keeps the cards", async () => {
		const { anki, state } = fakeAnki();
		const store = freshStore();
		const sync = createAnkiSync({ graphStore: graphStore(), ankiStore: store, sourceTitle: () => "Econ", cardWriter: scriptedWriter([]), anki });
		await sync.sync();
		state.reachable = false;
		await assert.rejects(sync.rebuild());
		assert.equal(store.readRecords().size, 3);
	});
});

describe("card giveaways", () => {
	it("refuses a front that already holds the answer", () => {
		assert.ok(givesAwayAnswer("Which came first and was national: Enterprise Zones policy (1980) or the Isle of Dogs zone (1982)?", "The **national policy**, 1980"));
		assert.ok(!givesAwayAnswer("When did the national Enterprise Zones policy begin?", "1980"));
		assert.match(cardProblem({ kind: "discriminate", format: "basic", front: "Policy (1980) or zone (1982): which came first?", back: "1980" }) ?? "", /gives the answer away/);
		assert.equal(cardProblem({ kind: "recall", format: "basic", front: "Which dock opened in 1802?", back: "West India Docks" }), null);
	});
});
