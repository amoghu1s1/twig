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
import { cardWriterPrompt, validateCardSubmit } from "../src/agent/subagents/card-writer.ts";
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
		const input = { propositions: ids.map((id) => ({ id, cards: [{ kind: "recall", front: `When does ${id} apply?`, back: `${id}.` }, { kind: "why", front: `Why ${id}?`, back: "Because." }] })) };
		return fauxAssistantMessage([fauxToolCall("submit_cards", input as ToolCall["arguments"], { id: `submit-${calls.length}` })], { stopReason: "toolUse" });
	};
	faux.setResponses([step, step, step, step]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** AnkiConnect fake: in-memory notes; `reachable` flips at will. */
function fakeAnki() {
	const state = { reachable: true, decks: new Set<string>(), notes: [] as Array<{ id: number; deck: string; tags: string[] }>, adds: 0 };
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
				case "addNotes": {
					const notes = params.notes as Array<{ deckName: string; tags: string[] }>;
					state.adds += notes.length;
					return notes.map((n) => {
						const id = 1000 + state.notes.length;
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
		assert.equal(deckName("Microeconomics"), "LearnHarness::Microeconomics");
		assert.equal(deckName("A::B"), "LearnHarness::A:B");
		assert.equal(deckName(undefined), "LearnHarness::Unsorted");
	});

	it("escapes markup, keeps line breaks, and converts math to MathJax", () => {
		assert.equal(ankiField("a < b\nc & d"), "a &lt; b<br>c &amp; d");
		assert.equal(ankiField("area $\\pi r^2$ and $$e^{i\\pi}$$"), "area \\(\\pi r^2\\) and \\[e^{i\\pi}\\]");
		assert.equal(ankiField("costs $5 and $6"), "costs $5 and $6"); // prices are not math
	});

	it("builds Basic notes tagged with the node id", () => {
		const record: AnkiNoteRecord = { nodeId: "n_1", sourceId: "chat_a", deck: "LearnHarness::Econ", createdAt: "x", cards: [{ kind: "recall", front: "Q", back: "A" }] };
		const note = toAnkiConnectNotes(record, "Opportunity cost")[0]!;
		assert.equal(note.deckName, "LearnHarness::Econ");
		assert.equal(note.modelName, "Basic");
		assert.deepEqual(note.tags, ["learnharness", "lh::n_1", "lh-card::recall"]);
		assert.match(note.fields.Back, /^A<br><br><small>Opportunity cost · Econ<\/small>$/);
		assert.equal(note.options.allowDuplicate, false);
	});

	it("renders an import file whose header maps deck and tag columns", () => {
		const record: AnkiNoteRecord = { nodeId: "n_1", sourceId: "chat_a", deck: "LearnHarness::Econ", createdAt: "x", cards: [{ kind: "recall", front: "Q\twith tab", back: "A" }] };
		const lines = renderAnkiTsv([record], new Map([["n_1", "Opportunity cost"]])).trimEnd().split("\n");
		assert.deepEqual(lines.slice(0, 5), ["#separator:tab", "#html:true", "#notetype:Basic", "#deck column:1", "#tags column:4"]);
		const cells = lines[5]!.split("\t");
		assert.equal(cells.length, 4);
		assert.equal(cells[0], "LearnHarness::Econ");
		assert.equal(cells[1], "Q with tab");
		assert.equal(cells[3], "learnharness lh::n_1 lh-card::recall");
	});
});

describe("store/anki", () => {
	it("round-trips records and skips invalid entries", () => {
		const file = path.join(tmp, "roundtrip.json");
		const store = createAnkiStore(file);
		assert.equal(store.readRecords().size, 0);
		store.upsertRecords([{ nodeId: "n_1", sourceId: "chat_a", deck: "LearnHarness::X", createdAt: "t", cards: [{ kind: "why", front: "Q", back: "A" }] }]);
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
		const card = { kind: "recall" as const, front: "Q", back: "A" };
		const batch = new Set(["n_1", "n_2"]);
		assert.equal(validateCardSubmit({ propositions: [{ id: "n_1", cards: [card] }, { id: "n_2", cards: [card] }] }, batch), null);
		assert.match(validateCardSubmit({ propositions: [{ id: "n_1", cards: [card] }] }, batch) ?? "", /missing cards for: n_2/);
		assert.match(validateCardSubmit({ propositions: [{ id: "n_9", cards: [card] }] }, batch) ?? "", /unknown proposition id/);
		assert.match(validateCardSubmit({ propositions: [{ id: "n_1", cards: [card] }, { id: "n_1", cards: [card] }, { id: "n_2", cards: [card] }] }, batch) ?? "", /twice/);
		assert.match(validateCardSubmit({ propositions: [{ id: "n_1", cards: [{ ...card, back: " " }] }, { id: "n_2", cards: [card] }] }, batch) ?? "", /empty card side/);
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
		assert.deepEqual([...state.decks], ["LearnHarness::Microeconomics"]);
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
		state.notes.push({ id: 1, deck: "LearnHarness::Econ", tags: ["learnharness", "lh::n_1"] });
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
		assert.match(sync.importFile(), /LearnHarness::chat_b/);
	});

	it("refuses honestly with no card-writer model", async () => {
		const sync = createAnkiSync({ graphStore: graphStore(), ankiStore: freshStore(), sourceTitle: () => "x", engineFor: () => undefined, anki: fakeAnki().anki });
		await assert.rejects(sync.sync(), ModelsNotConfiguredError);
	});
});
