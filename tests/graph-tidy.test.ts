/**
 * Tidy graph (fork, 2026-11-07):
 *
 *   core/graph-tidy.ts        merge / split / connect apply against an
 *                             in-memory ledger, and the refusals
 *   tidier.ts                 the submit → proposals filter
 *   server/graph-tidy.ts      faux tidier run → pending proposals → apply
 *                             (Anki retire hook) / skip / busy refusal
 *   server/anki-sync.ts       retire deletes the cards from Anki
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type ToolCall } from "@earendil-works/pi-ai";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { getGraph } from "../src/core/graph.ts";
import { applyTidyChange, tidyProblem, TIDY_SOURCE_ID } from "../src/core/graph-tidy.ts";
import { tidierPrompt, tidierProposals } from "../src/agent/subagents/tidier.ts";
import { createGraphTidy, TidyBusyError, type TidyResolveResult } from "../src/server/graph-tidy.ts";
import { createTidyStore } from "../src/store/tidy.ts";
import { createAnkiStore } from "../src/store/anki.ts";
import { createAnkiSync, type AnkiConnect } from "../src/server/anki-sync.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-tidy-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let files = 0;
const tmpFile = (name: string) => path.join(tmp, `${files++}-${name}`);

function node(id: string, name: string, statement: string, chatId: string): GraphNode {
	return { id, name, statement, aliases: [], createdAt: `2026-11-0${files % 9 + 1}T00:00:00.000Z`, provenance: [{ chatId, messageId: "m1" }] };
}

/** An in-memory ledger: the slice of GraphStore the tidy code touches. */
function memoryStore(nodes: GraphNode[], chains: GraphChain[]) {
	const state = { nodes: [...nodes], chains: [...chains], positions: {} as Record<string, { x: number; y: number }> };
	const store = {
		readNodes: () => state.nodes,
		readChains: () => state.chains,
		appendNode: (n: GraphNode) => { state.nodes.push(n); },
		appendChain: (c: GraphChain) => { state.chains.push(c); },
		rewriteLedgers: (next: { nodes?: GraphNode[]; chains?: GraphChain[] }) => {
			if (next.nodes) state.nodes = next.nodes;
			if (next.chains) state.chains = next.chains;
		},
		readPositions: () => state.positions,
		writePositions: (p: Record<string, { x: number; y: number }>) => { state.positions = p; },
	};
	return { store: store as unknown as GraphStore, state };
}

const DOCKS = "chat_docks";
const SLIGO = "chat_sligo";
const NODES = [
	node("n_abol", "Abolition and compensation", "Britain abolished colonial slavery in 1834 and paid owners £20 million.", DOCKS),
	node("n_wid", "West India Docks", "The West India Docks opened in 1802 for the West India trade.", DOCKS),
	node("n_merch", "West India merchants", "West India merchants financed the West India Docks.", DOCKS),
	node("n_abol2", "Slavery Abolition Act", "The Slavery Abolition Act ended slavery in most British colonies in 1834.", SLIGO),
	node("n_sligo", "Sligo in Jamaica", "The Marquis of Sligo governed Jamaica during emancipation.", SLIGO),
];
const CHAINS: GraphChain[] = [
	{ id: "arg_1", premises: ["n_wid"], conclusion: "n_merch", createdAt: "2026-11-01T00:00:00.000Z", provenance: [{ chatId: DOCKS, messageId: "" }] },
	{ id: "arg_2", premises: ["n_abol2"], conclusion: "n_sligo", createdAt: "2026-11-01T00:00:00.000Z", provenance: [{ chatId: SLIGO, messageId: "" }] },
];

describe("core/graph-tidy apply", () => {
	it("merge keeps the kept identity, folds the dropped wording in, and rewires chains", () => {
		const { store, state } = memoryStore([node("n_x", "Act", "Older wording.", SLIGO), ...NODES], CHAINS);
		state.positions = { n_abol2: { x: 1, y: 1 }, n_sligo: { x: 2, y: 2 } };
		const result = applyTidyChange(store, { kind: "merge", keep: "n_x", drop: "n_abol2" });
		assert.deepEqual(result.removedNodeIds, ["n_abol2"]);
		const graph = getGraph(store);
		assert.ok(!graph.nodes.some((n) => n.id === "n_abol2"));
		const kept = graph.nodes.find((n) => n.id === "n_x")!;
		assert.equal(kept.statement, "Older wording.");
		assert.ok(kept.aliases.includes(NODES[3]!.statement));
		assert.ok(graph.chains.some((c) => c.premises.includes("n_x") && c.conclusion === "n_sligo"));
		assert.deepEqual(Object.keys(state.positions), ["n_sligo"]);
	});

	it("merge keeps the kept node's identity even when the dropped node is older", () => {
		const { store } = memoryStore(NODES, CHAINS);
		applyTidyChange(store, { kind: "merge", keep: "n_abol2", drop: "n_abol" });
		const kept = getGraph(store).nodes.find((n) => n.id === "n_abol2")!;
		assert.equal(kept.name, "Slavery Abolition Act");
	});

	it("split adds the parts and a chain parts ⟹ original, deleting nothing", () => {
		const { store } = memoryStore(NODES, CHAINS);
		const result = applyTidyChange(store, { kind: "split", node: "n_abol", parts: [
			{ name: "Abolition 1834", statement: "Britain abolished colonial slavery in 1834." },
			{ name: "Owner compensation", statement: "Britain paid slave-owners £20 million in compensation." },
		] });
		assert.equal(result.createdNodeIds.length, 2);
		const graph = getGraph(store);
		assert.ok(graph.nodes.some((n) => n.id === "n_abol"));
		const chain = graph.chains.find((c) => c.conclusion === "n_abol")!;
		assert.deepEqual([...chain.premises].sort(), [...result.createdNodeIds].sort());
		const part = graph.nodes.find((n) => n.id === result.createdNodeIds[0])!;
		assert.equal(part.provenance[0]?.chatId, DOCKS);
	});

	it("connect makes a cross-topic chain, ending in a new bridge idea owned by Connections", () => {
		const { store } = memoryStore(NODES, CHAINS);
		const result = applyTidyChange(store, { kind: "connect", premises: ["n_abol2", "n_merch"], newIdea: { name: "Compensation to dock financiers", statement: "Compensation flowed to West India merchants." } });
		const graph = getGraph(store);
		const bridge = graph.nodes.find((n) => n.id === result.createdNodeIds[0])!;
		assert.equal(bridge.provenance[0]?.chatId, TIDY_SOURCE_ID);
		assert.ok(graph.chains.some((c) => c.conclusion === bridge.id && c.provenance[0]?.chatId === TIDY_SOURCE_ID));
	});

	it("refuses what no longer fits", () => {
		const nodes = new Map(NODES.map((n) => [n.id, n]));
		assert.match(tidyProblem({ kind: "merge", keep: "n_wid", drop: "n_gone" }, nodes, CHAINS) ?? "", /no longer exists/);
		assert.match(tidyProblem({ kind: "merge", keep: "n_wid", drop: "n_wid" }, nodes, CHAINS) ?? "", /itself/);
		assert.match(tidyProblem({ kind: "connect", premises: ["n_wid"], conclusion: "n_merch" }, nodes, CHAINS) ?? "", /different topics|already holds/);
		assert.match(tidyProblem({ kind: "connect", premises: ["n_abol2"], conclusion: "n_sligo" }, nodes, CHAINS) ?? "", /already holds/);
		assert.match(tidyProblem({ kind: "split", node: "n_abol", parts: [{ name: "a", statement: "b" }] }, nodes, CHAINS) ?? "", /two parts/);
		assert.equal(tidyProblem({ kind: "connect", premises: ["n_abol2"], conclusion: "n_merch" }, nodes, CHAINS), null);
		const { store } = memoryStore(NODES, CHAINS);
		assert.throws(() => applyTidyChange(store, { kind: "merge", keep: "n_wid", drop: "n_gone" }), /no longer exists/);
	});
});

describe("tidier", () => {
	it("prompts by topic with ids and chains", () => {
		const prompt = tidierPrompt(NODES, CHAINS, (id) => (id === DOCKS ? "London Docklands" : "Marquis of Sligo"));
		assert.match(prompt, /## Topic: London Docklands\n\[n_abol\] Abolition and compensation: /);
		assert.match(prompt, /## Topic: Marquis of Sligo/);
		assert.match(prompt, /n_wid => n_merch/);
	});

	it("keeps only proposals that fit, one merge per dropped node", () => {
		const byId = new Map(NODES.map((n) => [n.id, n]));
		const out = tidierProposals({
			merges: [
				{ keep: "n_abol2", drop: "n_abol", reason: "same act" },
				{ keep: "n_wid", drop: "n_abol", reason: "again" },
			],
			splits: [{ id: "n_abol", parts: [{ name: "a", statement: "A." }], reason: "too few parts" }],
			connections: [
				{ premises: ["n_abol2"], conclusion: "n_merch", reason: "cross-topic" },
				{ premises: ["n_wid"], conclusion: "n_merch", reason: "same topic, already chained" },
			],
		}, byId, CHAINS);
		assert.deepEqual(out.map((p) => p.reason), ["same act", "cross-topic"]);
	});
});

function fakeTidier(input: unknown) {
	const faux = createFauxCore({});
	faux.setResponses([() => fauxAssistantMessage([fauxToolCall("submit_tidy", input as ToolCall["arguments"], { id: "t1" })], { stopReason: "toolUse" })]);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("tidy service", () => {
	const submit = {
		merges: [{ keep: "n_abol2", drop: "n_abol", reason: "Both state the 1834 abolition." }],
		splits: [],
		connections: [{ premises: ["n_abol2", "n_merch"], newIdea: { name: "Compensation and the docks", statement: "Compensation reached the merchants who financed the West India Docks." }, reason: "Links Sligo's emancipation to the docks' financiers." }],
	};

	it("runs, stores pending proposals, applies one and skips the other", async () => {
		const { store } = memoryStore(NODES, CHAINS);
		const applied: TidyResolveResult[] = [];
		const tidy = createGraphTidy({ graphStore: store, store: createTidyStore(tmpFile("tidy.json")), topicTitle: (id) => id, tidier: fakeTidier(submit), onApplied: (r) => applied.push(r) });
		assert.deepEqual(tidy.start(), { started: true });
		assert.deepEqual(tidy.start(), { started: false });
		await tidy.settled();
		const pending = tidy.status().proposals.filter((p) => p.status === "pending");
		assert.equal(pending.length, 2);
		const merge = pending.find((p) => p.change.kind === "merge")!;
		const connect = pending.find((p) => p.change.kind === "connect")!;
		const result = tidy.resolve([merge.id], "apply");
		assert.equal(result.applied, 1);
		assert.deepEqual(applied[0]?.removedNodeIds, ["n_abol"]);
		assert.equal(tidy.resolve([connect.id], "skip").skipped, 1);
		assert.ok(tidy.status().proposals.every((p) => p.status !== "pending"));
		assert.ok(!getGraph(store).nodes.some((n) => n.id === "n_abol"));
	});

	it("marks a proposal the graph outgrew instead of half-applying it", async () => {
		const { store } = memoryStore(NODES, CHAINS);
		const tidy = createGraphTidy({ graphStore: store, store: createTidyStore(tmpFile("tidy.json")), topicTitle: (id) => id, tidier: fakeTidier(submit) });
		tidy.start();
		await tidy.settled();
		applyTidyChange(store, { kind: "merge", keep: "n_wid", drop: "n_merch" }); // the connection's premise goes
		const connect = tidy.status().proposals.find((p) => p.change.kind === "connect")!;
		const result = tidy.resolve([connect.id], "apply");
		assert.equal(result.applied, 0);
		assert.match(result.failed[0]?.error ?? "", /no longer exists/);
	});

	it("refuses to apply while an extraction runs", async () => {
		const { store } = memoryStore(NODES, CHAINS);
		const tidy = createGraphTidy({ graphStore: store, store: createTidyStore(tmpFile("tidy.json")), topicTitle: (id) => id, tidier: fakeTidier(submit), extractionRunning: () => true });
		tidy.start();
		await tidy.settled();
		assert.throws(() => tidy.resolve(tidy.status().proposals.map((p) => p.id), "apply"), TidyBusyError);
	});

	it("records a failed run", async () => {
		const { store } = memoryStore(NODES, CHAINS);
		const tidy = createGraphTidy({ graphStore: store, store: createTidyStore(tmpFile("tidy.json")), topicTitle: (id) => id, tidier: fakeTidier({ merges: [{ keep: "n_nope", drop: "n_abol", reason: "x" }], splits: [], connections: [] }) });
		tidy.start();
		await tidy.settled();
		assert.ok(tidy.status().error, "the failure is kept for the panel");
		assert.equal(tidy.status().proposals.length, 0);
	});
});

describe("anki retire", () => {
	it("deletes a retired node's cards from Anki and forgets them", async () => {
		const notes = [{ id: 5, tags: ["lh::n_abol"] }, { id: 6, tags: ["lh::n_wid"] }];
		const deleted: number[] = [];
		const anki: AnkiConnect = {
			async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
				if (action === "version") return 6 as T;
				if (action === "findNotes") {
					const tag = /tag:([^"]+)/.exec(params.query as string)?.[1];
					return notes.filter((n) => n.tags.includes(tag ?? "")).map((n) => n.id) as T;
				}
				if (action === "deleteNotes") { deleted.push(...(params.notes as number[])); return null as T; }
				throw new Error(`unexpected ${action}`);
			},
		};
		const ankiStore = createAnkiStore(tmpFile("cards.json"));
		const record = (nodeId: string) => ({ nodeId, sourceId: DOCKS, deck: "LearnHarness::Docks", createdAt: "t", deliveredAt: "t", noteIds: [nodeId === "n_abol" ? 5 : 6], cards: [{ kind: "recall" as const, front: "Q", back: "A" }] });
		ankiStore.upsertRecords([record("n_abol"), record("n_wid")]);
		const { store } = memoryStore(NODES, CHAINS);
		const sync = createAnkiSync({ graphStore: store, ankiStore, sourceTitle: () => "Docks", anki });
		assert.equal(await sync.retire(["n_abol", "n_missing"]), 1);
		assert.deepEqual(deleted, [5]);
		assert.deepEqual([...ankiStore.readRecords().keys()], ["n_wid"]);
	});
});
