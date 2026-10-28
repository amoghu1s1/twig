/**
 * READINGS (docs/readings.md) — opt-in companion documents.
 *
 * Pins: the request grammar (kind-specific anchors), the snapshot
 * builders (the "deeper, not further" fence, the overview's plan-node
 * list, the transcript budget, live node statuses), the
 * citation law (every cited URL was fetched successfully in the run), the
 * per-kind submit shape, the node/chat folds, the suggest_reading offer,
 * and the writer pipeline end to end with a scripted engine — researched
 * (fetch → cite → ready; uncited-fetch rejection → retry), model mode,
 * abort, and the BYOK refusal. Runs under an isolated LH_DATA_DIR (the
 * seam is set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-readings-"));
process.env.LH_DATA_DIR = TMP_DATA;

const core = await import("../src/core/readings.ts");
const contracts = await import("../src/core/contracts.ts");
const { readingStore } = await import("../src/store/readings.ts");
const { createReadingsPipeline, submittedReadingProblem, writerTaskText, composeWriterPrompt, readingRunStatuses } = await import(
	"../src/agent/subagents/readings.ts"
);
const { readingTools, SUGGEST_READING_ACK } = await import("../src/agent/tools/readings.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type ReadingRecord = import("../src/core/contracts.ts").ReadingRecord;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple } as PiEngine;
}

function assistant(id: string, content: unknown[]): LhMessage {
	return {
		id,
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openrouter",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "toolUse",
		timestamp: 1,
	} as never;
}

const TREE = {
	version: 1,
	nodes: [
		{ id: "limits", title: "Limits" },
		{ id: "derivative", title: "The derivative", summary: "rate of change as a limit" },
		{ id: "chain-rule", title: "The chain rule" },
	],
	edges: [
		{ from: "limits", to: "derivative" },
		{ from: "derivative", to: "chain-rule" },
	],
};

function lessonMessages(): LhMessage[] {
	return [
		{ id: "u1", role: "user", content: "I want to understand the chain rule", timestamp: 1 } as never,
		assistant("a1", [
			{
				type: "toolCall",
				id: "pd",
				name: "probe_done",
				arguments: { assessment: { summary: "solid on limits", strands: [{ strand: "limits", assessment: "holds the epsilon picture" }] } },
			},
		]),
		assistant("a2", [{ type: "text", text: "Here is the derivative, built from limits." }]),
		assistant("a3", [{ type: "toolCall", id: "q1", name: "quiz", arguments: { nodeId: "limits", type: "check" } }]),
		assistant("a4", [{ type: "toolCall", id: "q2", name: "quiz", arguments: { nodeId: "derivative", type: "check" } }]),
	];
}

const LONG_BODY = "## Section\n\n" + "A motivated explanation that builds on what he holds. ".repeat(10);

// ─── request grammar ────────────────────────────────────────────────────────

describe("parseReadingRequest", () => {
	it("enforces kind-specific anchors", () => {
		assert.equal(core.parseReadingRequest({ kind: "deep-dive" }).ok, false);
		assert.equal(core.parseReadingRequest({ kind: "deep-dive", chatId: "c" }).ok, false, "needs a node or a passage");
		assert.equal(core.parseReadingRequest({ kind: "deep-dive", chatId: "c", planNodeId: "n" }).ok, true);
		assert.equal(core.parseReadingRequest({ kind: "deep-dive", chatId: "c", passage: "some text" }).ok, true);
		assert.equal(core.parseReadingRequest({ kind: "recap" }).ok, false);
		assert.equal(core.parseReadingRequest({ kind: "primer" }).ok, false);
		assert.equal(core.parseReadingRequest({ kind: "primer", topic: "Bayes" }).ok, true);
		assert.equal(core.parseReadingRequest({ kind: "overview" }).ok, false);
		assert.equal(core.parseReadingRequest({ kind: "overview", topic: "Bayes" }).ok, true);
		assert.equal(core.parseReadingRequest({ kind: "overview", chatId: "c" }).ok, true);
		assert.equal(core.parseReadingRequest({ kind: "node", nodeIds: [] }).ok, false);
		assert.equal(core.parseReadingRequest({ kind: "node", nodeIds: ["n_1", "n_1", 3] }).ok, true);
		assert.equal(core.parseReadingRequest({ kind: "essay" }).ok, false);
		assert.equal(core.parseReadingRequest({ kind: "recap", chatId: "c", mode: "loud" }).ok, false);
	});

	it("cleans fields: trims, caps, dedupes picks", () => {
		const r = core.parseReadingRequest({ kind: "node", nodeIds: ["a", "a", "b"], request: "  focus on x  " });
		assert.ok(r.ok);
		assert.deepEqual(r.value.nodeIds, ["a", "b"]);
		assert.equal(r.value.request, "focus on x");
		const long = core.parseReadingRequest({ kind: "primer", topic: "x".repeat(5000) });
		assert.ok(long.ok && long.value.topic!.length === core.MAX_TOPIC_CHARS);
	});

	it("a re-run needs only the source id", () => {
		const r = core.parseReadingRequest({ rerunOf: "rd_1", mode: "model" });
		assert.ok(r.ok && r.value.rerunOf === "rd_1" && r.value.mode === "model");
	});
});

// ─── snapshots ──────────────────────────────────────────────────────────────

describe("snapshots", () => {
	const chat = { title: "Chain rule", messages: lessonMessages(), tree: TREE };

	it("a node deep dive fences off the nodes not yet reached", () => {
		const built = core.buildSessionSnapshot("deep-dive", chat, { planNodeId: "derivative" });
		assert.ok(built.ok);
		assert.deepEqual(built.snapshot.focus, { title: "The derivative", summary: "rate of change as a limit" });
		assert.deepEqual(built.snapshot.upcoming, ["The chain rule"]);
		assert.match(built.snapshot.assessment!, /holds the epsilon picture/);
		assert.match(built.snapshot.plan!, /\[current\] The derivative/);
		assert.match(built.snapshot.plan!, /\[visited\] Limits/);
	});

	it("an overview maps every plan node and fences off the ones not yet reached", () => {
		const built = core.buildSessionSnapshot("overview", chat, {});
		assert.ok(built.ok);
		assert.deepEqual(built.snapshot.planNodes, [
			{ id: "limits", title: "Limits" },
			{ id: "derivative", title: "The derivative" },
			{ id: "chain-rule", title: "The chain rule" },
		]);
		assert.deepEqual(built.snapshot.upcoming, ["The chain rule"]);
		assert.equal(built.snapshot.focus, undefined);
		const noPlan = core.buildSessionSnapshot("overview", { title: "x", messages: lessonMessages() }, {});
		assert.ok(noPlan.ok);
		assert.equal(noPlan.snapshot.planNodes, undefined);
		assert.equal(core.provisionalTitle("overview", { topic: "Bayes" }), "Overview: Bayes");
	});

	it("node statuses are read live from the session, unknown nodes left out", () => {
		assert.deepEqual(core.planNodeStatuses(chat, ["limits", "derivative", "chain-rule", "gone"]), {
			limits: "visited",
			derivative: "current",
			"chain-rule": "upcoming",
		});
		assert.deepEqual(core.planNodeStatuses({ title: "x", messages: [] }, ["limits"]), {});
	});

	it("an unknown plan node is refused", () => {
		const built = core.buildSessionSnapshot("deep-dive", chat, { planNodeId: "nope" });
		assert.equal(built.ok, false);
	});

	it("a recap needs something to recap", () => {
		const empty = core.buildSessionSnapshot("recap", { title: "x", messages: [] }, {});
		assert.equal(empty.ok, false);
		const full = core.buildSessionSnapshot("recap", chat, {}, [{ id: "n_1", name: "Chain rule", statement: "d/dx f(g(x)) = f'(g(x))g'(x)" }]);
		assert.ok(full.ok && full.snapshot.transcript && full.snapshot.propositions?.length === 1);
	});

	it("the transcript budget keeps the opening and the recent stretch, honestly marked", () => {
		const md = "A".repeat(500) + "B".repeat(500);
		const { text, trimmed } = core.budgetTranscript(md, 200);
		assert.equal(trimmed, true);
		assert.ok(text.startsWith("A".repeat(40)));
		assert.ok(text.endsWith("B".repeat(160)));
		assert.match(text, /omitted/);
		assert.deepEqual(core.budgetTranscript("short", 200), { text: "short", trimmed: false });
	});

	it("the writer's task text carries the fence and the snapshot", () => {
		const built = core.buildSessionSnapshot("deep-dive", chat, { planNodeId: "derivative" });
		assert.ok(built.ok);
		const text = writerTaskText({ kind: "deep-dive", mode: "researched", anchor: {}, snapshot: built.snapshot, title: "t" });
		assert.match(text, /Not yet reached in his lesson \(name only — never explain\)/);
		assert.match(text, /- The chain rule/);
		assert.match(text, /<transcript>/);
	});

	it("an overview's task text lists the plan nodes a section may tag", () => {
		const built = core.buildSessionSnapshot("overview", chat, {});
		assert.ok(built.ok);
		const text = writerTaskText({ kind: "overview", mode: "model", anchor: {}, snapshot: built.snapshot, title: "t" });
		assert.match(text, /Write an OVERVIEW/);
		assert.match(text, /Plan nodes a section may tag/);
		assert.match(text, /- `chain-rule` — The chain rule/);
	});

	it("the writer prompt composes base, mode, kind and the shared law", () => {
		const p = composeWriterPrompt("primer", "model");
		assert.match(p, /# The writer/);
		assert.match(p, /model-knowledge mode/);
		assert.match(p, /a primer/);
		assert.match(p, /## Accuracy/);
		assert.match(composeWriterPrompt("overview", "model"), /Map, not mechanism/);
	});
});

// ─── the citation law + per-kind shape ──────────────────────────────────────

describe("the citation law", () => {
	it("normalizes URLs for comparison", () => {
		assert.equal(core.normalizeUrl("HTTPS://Example.com/a/#frag"), "https://example.com/a");
		assert.equal(core.normalizeUrl("https://example.com/a?x=1"), "https://example.com/a?x=1");
	});

	it("reads fetch outcomes from the tools' failure strings", () => {
		assert.equal(core.fetchSucceeded("web_fetch", "# Title\n\ncontent"), true);
		assert.equal(core.fetchSucceeded("web_fetch", "web_fetch failed for x: 404"), false);
		assert.equal(core.fetchSucceeded("web_fetch", "web_fetch: this URL is a PDF document — call web_fetch_pdf"), false);
		assert.equal(core.fetchSucceeded("web_fetch_pdf", "web_fetch_pdf failed: invalid URL"), false);
	});

	it("rejects any cited URL that was not fetched; model mode cites nothing", () => {
		const fetched = new Set([core.normalizeUrl("https://a.org/x")]);
		assert.deepEqual(core.citationProblems([{ url: "https://a.org/x/" }], fetched, "researched"), []);
		assert.equal(core.citationProblems([{ url: "https://b.org" }], fetched, "researched").length, 1);
		assert.equal(core.citationProblems([{ url: "https://a.org/x" }], fetched, "model").length, 1);
		assert.deepEqual(core.citationProblems([], new Set(), "model"), []);
	});

	it("validates the per-kind submit shape", () => {
		const base = { title: "T", body: LONG_BODY, terms: [], sections: [], sources: [], furtherReading: [] };
		assert.equal(submittedReadingProblem("deep-dive", "model", base, new Set()), null);
		assert.match(submittedReadingProblem("primer", "model", base, new Set())!, /at least 3/);
		const primer = { ...base, body: "Intro.", terms: [1, 2, 3].map((i) => ({ term: `t${i}`, definition: "d" })) };
		assert.equal(submittedReadingProblem("primer", "model", primer, new Set()), null);
		assert.match(submittedReadingProblem("deep-dive", "model", { ...base, terms: primer.terms }, new Set())!, /primers only/);
		assert.match(submittedReadingProblem("recap", "researched", base, new Set())!, /furtherReading/);
		assert.match(submittedReadingProblem("deep-dive", "model", { ...base, body: "short" }, new Set())!, /too short/);
	});

	it("validates the overview's sections and their plan-node tags", () => {
		const sec = (planNodeIds?: string[]) => ({ heading: "H", body: LONG_BODY, ...(planNodeIds ? { planNodeIds } : {}) });
		const base = { title: "T", body: "Intro.", terms: [], sources: [], furtherReading: [] };
		const plan = new Set(["limits", "derivative"]);
		assert.equal(submittedReadingProblem("overview", "model", { ...base, sections: [sec(), sec(["limits"])] }, new Set(), plan), null);
		assert.match(submittedReadingProblem("overview", "model", { ...base, sections: [sec()] }, new Set(), plan)!, /at least 2/);
		assert.match(submittedReadingProblem("overview", "model", { ...base, sections: [sec(), sec(["nope"])] }, new Set(), plan)!, /Unknown plan node ids in planNodeIds: nope/);
		assert.match(submittedReadingProblem("overview", "model", { ...base, sections: [sec(), sec(["limits"])] }, new Set())!, /no lesson plan/);
		assert.match(
			submittedReadingProblem("overview", "model", { ...base, sections: [sec(), { heading: "", body: "x" }] }, new Set(), plan)!,
			/heading and a body/,
		);
		assert.match(submittedReadingProblem("deep-dive", "model", { ...base, body: LONG_BODY, sections: [sec()] }, new Set())!, /overviews only/);
		const linked = { ...base, sections: [sec(), { heading: "H", body: `${LONG_BODY} [x](https://never.fetched/p)` }] };
		assert.match(submittedReadingProblem("overview", "researched", linked, new Set(), plan)!, /never successfully fetched/);
	});

	it("links written into the body are citations too", () => {
		const linked = { title: "T", body: `${LONG_BODY} See [this](https://never.fetched/page).`, terms: [], sections: [], sources: [], furtherReading: [] };
		assert.match(submittedReadingProblem("deep-dive", "researched", linked, new Set())!, /never successfully fetched/);
		assert.equal(submittedReadingProblem("deep-dive", "researched", linked, new Set([core.normalizeUrl("https://never.fetched/page")])), null);
		assert.match(submittedReadingProblem("deep-dive", "model", linked, new Set())!, /no URLs/);
		assert.deepEqual(core.urlsInText("a https://x.org/a. and (https://y.org/b) [c](https://z.org/c)"), ["https://x.org/a", "https://y.org/b", "https://z.org/c"]);
	});
});

// ─── folds ──────────────────────────────────────────────────────────────────

describe("reading folds", () => {
	const r = (id: string, anchor: ReadingRecord["anchor"], createdAt: string, supersedes?: string) =>
		({ id, anchor, createdAt, ...(supersedes ? { supersedes } : {}) }) as Pick<ReadingRecord, "id" | "anchor" | "createdAt" | "supersedes">;

	it("a node's readings: picked it, or came from a session it came up in; superseded hidden", () => {
		const all = [
			r("a", { nodeIds: ["n1"] }, "2026-01-01"),
			r("b", { chatId: "c1" }, "2026-01-02"),
			r("c", { chatId: "c2" }, "2026-01-03"),
			r("d", { chatId: "c1" }, "2026-01-04", "b"),
		];
		const got = core.readingsForNode(all, { id: "n1", provenance: [{ chatId: "c1" }] }).map((x) => x.id);
		assert.deepEqual(got, ["d", "a"]);
	});

	it("a failed re-run never hides the good original", () => {
		const all = [
			{ ...r("a", { chatId: "c1" }, "2026-01-01"), status: "ready" as const },
			{ ...r("b", { chatId: "c1" }, "2026-01-02", "a"), status: "error" as const },
		];
		assert.deepEqual(core.readingsForChat(all, "c1").map((x) => x.id), ["b", "a"]);
	});

	it("a session's readings, newest first, superseded hidden", () => {
		const all = [r("a", { chatId: "c1" }, "2026-01-01"), r("b", { chatId: "c1" }, "2026-01-02", "a"), r("c", { chatId: "c2" }, "2026-01-03")];
		assert.deepEqual(core.readingsForChat(all, "c1").map((x) => x.id), ["b"]);
	});
});

// ─── suggest_reading ────────────────────────────────────────────────────────

describe("suggest_reading (the teacher's offer)", () => {
	const tool = readingTools({ chatId: "c", chatStore: { getChat: () => ({ tree: TREE }) as never } })[contracts.SUGGEST_READING_TOOL]!;
	const text = (res: { content: unknown[] }) => (res.content[0] as { text: string }).text;

	it("acks an offer and generates nothing", async () => {
		const res = await tool.execute("x", { kind: "deep-dive", planNodeId: "derivative", title: "Origins", why: "the history" } as never);
		assert.equal(res.isError, undefined);
		assert.equal(text(res), SUGGEST_READING_ACK);
		assert.equal(readingStore.listReadings().length, 0);
	});

	it("refuses a deep-dive offer on a node the plan lacks", async () => {
		const res = await tool.execute("x", { kind: "deep-dive", planNodeId: "nope", title: "x", why: "y" } as never);
		assert.equal(res.isError, true);
	});
});

// ─── the writer pipeline ────────────────────────────────────────────────────

function queued(over: Partial<ReadingRecord> = {}): ReadingRecord {
	const now = new Date().toISOString();
	const record: ReadingRecord = {
		id: `rd_test_${Math.random().toString(36).slice(2, 10)}`,
		kind: "deep-dive",
		mode: "researched",
		status: "queued",
		title: "Deep dive: The derivative",
		anchor: { chatId: "c1", planNodeId: "derivative" },
		snapshot: { focus: { title: "The derivative" } },
		createdAt: now,
		updatedAt: now,
		...over,
	};
	readingStore.createReading(record);
	return record;
}

describe("the writer pipeline", () => {
	const URL_OK = "https://example.org/derivative";

	async function withFetchStub<T>(fn: () => Promise<T>): Promise<T> {
		const real = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("Synthetic page about derivatives.", { headers: { "content-type": "text/plain" } })) as typeof fetch;
		try {
			return await fn();
		} finally {
			globalThis.fetch = real;
		}
	}

	it("researched: fetch, cite only what was fetched (retry on a violation), land ready", async () => {
		const record = queued();
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_fetch", { url: URL_OK }, { id: "f1" })], { stopReason: "toolUse" }),
			// First submit cites an unfetched URL → rejected by the citation law.
			fauxAssistantMessage(
				[
					fauxToolCall(
						"submit_reading",
						{ title: "Where the derivative comes from", body: LONG_BODY, sources: [{ title: "Bogus", url: "https://never.fetched/x" }] },
						{ id: "s1" },
					),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxToolCall("submit_reading", { title: "Where the derivative comes from", body: LONG_BODY, sources: [{ title: "Ex", url: URL_OK }] }, { id: "s2" })],
				{ stopReason: "toolUse" },
			),
		]);
		const pipeline = createReadingsPipeline({ readingStore, engine, searchProvider: () => null });
		await withFetchStub(() => pipeline.run(record.id));
		const done = readingStore.getReading(record.id)!;
		assert.equal(done.status, "ready", done.error);
		assert.equal(done.title, "Where the derivative comes from");
		assert.deepEqual(done.sources, [{ title: "Ex", url: URL_OK }]);
		assert.ok(done.usage && done.usage.steps >= 3, "usage accumulates per model call");
		assert.equal(readingRunStatuses().length, 0, "the registry row is gone");
	});

	it("model mode: no tools, no sources — a cited URL is rejected", async () => {
		const record = queued({ mode: "model" });
		const engine = fauxEngine([
			fauxAssistantMessage(
				[fauxToolCall("submit_reading", { title: "T", body: LONG_BODY, sources: [{ title: "x", url: URL_OK }] }, { id: "s1" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("submit_reading", { title: "T", body: LONG_BODY }, { id: "s2" })], { stopReason: "toolUse" }),
		]);
		await createReadingsPipeline({ readingStore, engine }).run(record.id);
		const done = readingStore.getReading(record.id)!;
		assert.equal(done.status, "ready", done.error);
		assert.equal(done.sources, undefined);
	});

	it("an overview lands its sections, tags deduped, unknown tags retried", async () => {
		const record = queued({
			kind: "overview",
			mode: "model",
			anchor: { chatId: "c1" },
			snapshot: { planNodes: [{ id: "limits", title: "Limits" }] },
		});
		const sections = (ids: string[]) => [
			{ heading: "Why it exists", body: LONG_BODY, planNodeIds: [] as string[] },
			{ heading: "Limits", body: LONG_BODY, planNodeIds: ids },
		];
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("submit_reading", { title: "The map", body: "Intro.", sections: sections(["nope"]) }, { id: "s1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[fauxToolCall("submit_reading", { title: "The map", body: "Intro.", sections: sections(["limits", "limits"]) }, { id: "s2" })],
				{ stopReason: "toolUse" },
			),
		]);
		await createReadingsPipeline({ readingStore, engine }).run(record.id);
		const done = readingStore.getReading(record.id)!;
		assert.equal(done.status, "ready", done.error);
		assert.equal(done.sections?.length, 2);
		assert.equal(done.sections?.[0]!.planNodeIds, undefined);
		assert.deepEqual(done.sections?.[1]!.planNodeIds, ["limits"]);
	});

	it("a writer that never submits lands error, honestly", async () => {
		const record = queued({ mode: "model" });
		const engine = fauxEngine([fauxAssistantMessage([fauxText("Here is my essay.")])]);
		await createReadingsPipeline({ readingStore, engine }).run(record.id);
		const done = readingStore.getReading(record.id)!;
		assert.equal(done.status, "error");
		assert.match(done.error!, /without submitting/);
	});

	it("no writer model configured → refused, never run", async () => {
		const record = queued();
		const pipeline = createReadingsPipeline({ readingStore, engineFor: () => undefined });
		assert.match(pipeline.refusal()!, /No model configured/);
		await pipeline.run(record.id);
		assert.equal(readingStore.getReading(record.id)!.status, "error");
	});

	it("abort stops a live run and settles it as Stopped", async () => {
		const record = queued({ mode: "model" });
		const engine = fauxEngine([
			(_ctx, _opts, state) =>
				new Promise((resolve) => {
					const sig = (state as { signal?: AbortSignal } | undefined)?.signal;
					setTimeout(() => resolve(fauxAssistantMessage("late")), 5_000);
					sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
				}),
		]);
		const pipeline = createReadingsPipeline({ readingStore, engine });
		const running = pipeline.run(record.id);
		for (let i = 0; i < 50 && !pipeline.abort(record.id); i++) await new Promise((r) => setTimeout(r, 10));
		await running;
		const done = readingStore.getReading(record.id)!;
		assert.equal(done.status, "error");
		assert.equal(done.error, "Stopped");
	});

	it("the boot sweep marks only stale orphans", () => {
		const stale = queued({ status: "writing", updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
		const fresh = queued({ status: "writing" });
		// createReading stamps nothing; re-write the stale timestamp directly.
		readingStore.updateReading(stale.id, { updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
		const pipeline = createReadingsPipeline({ readingStore });
		assert.ok(pipeline.sweep() >= 1);
		assert.equal(readingStore.getReading(stale.id)!.status, "error");
		assert.equal(readingStore.getReading(fresh.id)!.status, "writing");
	});
});

// ─── the store ──────────────────────────────────────────────────────────────

describe("the reading store", () => {
	it("refuses a record stamped newer than this build", () => {
		const r = queued();
		const file = path.join(TMP_DATA, "readings", `${r.id}.json`);
		const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
		fs.writeFileSync(file, JSON.stringify({ ...raw, version: contracts.CURRENT_READING_VERSION + 1 }));
		assert.equal(readingStore.getReading(r.id), null);
	});

	it("deletes", () => {
		const r = queued();
		assert.equal(readingStore.deleteReading(r.id), true);
		assert.equal(readingStore.getReading(r.id), null);
		assert.equal(readingStore.deleteReading(r.id), false);
	});
});
