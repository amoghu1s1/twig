/**
 * DISCUSS ON A READING (docs/readings.md §14) — questions inside a reading.
 *
 * Pins: the ask grammar; citations derived from the fetch log (Sources =
 * fetched + linked, everything else unverified, rendered unlinked);
 * passage-thread placement (its block, else the side chat); the teacher's
 * marker (question AND answer, deterministic id, a quiet lesson line, the
 * model sees its text); the export's Discussion section; the store; the
 * companion pipeline end to end with a scripted engine (streamed live
 * view, researched citations, model mode, follow-up history, abort keeps
 * the partial, BYOK refusal, orphan settle); the server's ask rules; and
 * the steer registry's HELD NOTE (never a wake — rides the next run).
 * Runs under an isolated LH_DATA_DIR (set before any config-loading import).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-discussions-"));
process.env.LH_DATA_DIR = TMP_DATA;

const core = await import("../src/core/reading-discussions.ts");
const { SIDE_THREAD_ID } = await import("../src/core/contracts.ts");
const { readingStore } = await import("../src/store/readings.ts");
const { readingDiscussionStore } = await import("../src/store/reading-discussions.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { createDiscussionPipeline, companionTaskText, composeCompanionPrompt, subscribeAnswer, answerRunStatuses, patchExchange } = await import(
	"../src/agent/subagents/reading-discussions.ts"
);
const { projectView } = await import("../src/core/view.ts");
const { toLlmMessages } = await import("../src/core/native-messages.ts");
type PiEngine = import("../src/agent/models.ts").PiEngine;
type ReadingRecord = import("../src/core/contracts.ts").ReadingRecord;
type ReadingDiscussionRecord = import("../src/core/contracts.ts").ReadingDiscussionRecord;
type DiscussionExchange = import("../src/core/contracts.ts").DiscussionExchange;
type LhMessage = import("../src/core/native-messages.ts").LhMessage;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 8, max: 8 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple } as PiEngine;
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
	const start = Date.now();
	while (!cond()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
		await delay(10);
	}
}

let seq = 0;
function readyReading(over: Partial<ReadingRecord> = {}): ReadingRecord {
	const now = new Date().toISOString();
	const r: ReadingRecord = {
		id: `rd_test_${++seq}`,
		kind: "deep-dive",
		mode: "researched",
		status: "ready",
		title: "Where the derivative comes from",
		anchor: {},
		snapshot: { sessionTitle: "Calculus", plan: "- limits (visited)" },
		body: "The derivative is a limit.\n\nIt measures a rate.",
		createdAt: now,
		updatedAt: now,
		...over,
	};
	readingStore.createReading(r);
	return r;
}

/** Queue one exchange the way the server does (side chat or a new thread). */
function queueExchange(readingId: string, opts: { question: string; mode?: "researched" | "model"; passage?: string; threadId?: string }) {
	const now = new Date().toISOString();
	const exchange: DiscussionExchange = { id: `dx_${++seq}`, question: opts.question, mode: opts.mode ?? "model", status: "queued", askedAt: now };
	const threadId = opts.passage ? `dt_${++seq}` : (opts.threadId ?? SIDE_THREAD_ID);
	readingDiscussionStore.mutateDiscussion(readingId, (cur) => {
		const base = cur ?? core.emptyDiscussion(readingId, now);
		if (opts.passage) return { ...base, threads: [...base.threads, { id: threadId, passage: opts.passage, blockKey: "body:0", exchanges: [exchange], createdAt: now }] };
		if (threadId === SIDE_THREAD_ID) return { ...base, side: { ...base.side, exchanges: [...base.side.exchanges, exchange] } };
		return { ...base, threads: base.threads.map((t) => (t.id === threadId ? { ...t, exchanges: [...t.exchanges, exchange] } : t)) };
	});
	return { threadId, exchangeId: exchange.id };
}

function exchangeOf(readingId: string, exchangeId: string): DiscussionExchange {
	const d = readingDiscussionStore.getDiscussion(readingId)!;
	return [d.side, ...d.threads].flatMap((t) => t.exchanges).find((x) => x.id === exchangeId)!;
}

// ─── the pure core ──────────────────────────────────────────────────────────

describe("parseDiscussionAsk", () => {
	it("needs a question and a mode; a passage starts a thread, a threadId continues one, never both", () => {
		assert.equal(core.parseDiscussionAsk({ mode: "model" }).ok, false);
		assert.equal(core.parseDiscussionAsk({ question: "why?", mode: "fast" }).ok, false);
		assert.deepEqual(core.parseDiscussionAsk({ question: "  why?  ", mode: "model" }), { ok: true, value: { question: "why?", mode: "model" } });
		assert.deepEqual(core.parseDiscussionAsk({ question: "q", mode: "researched", passage: "a  b\n c", blockKey: "sec:1:2" }), {
			ok: true,
			value: { question: "q", mode: "researched", passage: "a b c", blockKey: "sec:1:2" },
		});
		assert.equal(core.parseDiscussionAsk({ question: "q", mode: "model", passage: "p", threadId: "side" }).ok, false);
		const long = core.parseDiscussionAsk({ question: "x".repeat(10_000), mode: "model" });
		assert.ok(long.ok && long.value.question.length === core.MAX_QUESTION_CHARS);
	});
});

describe("citations from the fetch log", () => {
	const answer = "See [the notes](https://example.org/notes#s2) and https://never.fetched/x. Also [again](https://example.org/notes).";

	it("researched: Sources are the fetched URLs the answer links; the rest are unverified", () => {
		const { sources, unverifiedUrls } = core.answerCitations(answer, new Set(["https://example.org/notes"]), "researched");
		assert.deepEqual(sources, [{ title: "the notes", url: "https://example.org/notes#s2" }]);
		assert.deepEqual(unverifiedUrls, ["https://never.fetched/x"]);
	});

	it("model mode: every URL is unverified, nothing is a source", () => {
		const { sources, unverifiedUrls } = core.answerCitations(answer, new Set(["https://example.org/notes"]), "model");
		assert.deepEqual(sources, []);
		assert.equal(unverifiedUrls.length, 2);
	});

	it("unverified links render unlinked with a mark; verified links stay links", () => {
		const md = core.markUnverifiedLinks("A [page](https://bad.example/p) and https://bad.example/q, plus [ok](https://good.example/).", [
			"https://bad.example/p",
			"https://bad.example/q",
		]);
		assert.equal(md, "A page *(unverified link)* and `https://bad.example/q` *(unverified link)*, plus [ok](https://good.example/).");
		assert.equal(core.markUnverifiedLinks("unchanged https://x.org", []), "unchanged https://x.org");
	});
});

describe("placement", () => {
	it("a thread sits after its rendered block; an unknown or missing block falls back to the side chat", () => {
		const t = (id: string, blockKey?: string) => ({ id, blockKey });
		const { inline, fallback } = core.placeThreads([t("a", "body:0"), t("b", "body:0"), t("c", "sec:9:9"), t("d")], new Set(["body:0", "body:1"]));
		assert.deepEqual(inline.get("body:0")?.map((x) => x.id), ["a", "b"]);
		assert.deepEqual(fallback.map((x) => x.id), ["c", "d"]);
	});
});

describe("the teacher's marker", () => {
	const marker = core.buildDiscussionMarker({
		chatId: "c1",
		readingId: "rd_1",
		readingTitle: "Limits, properly",
		readingKind: "deep-dive",
		thread: { id: "dt_1", passage: "the limit exists" },
		exchange: { id: "dx_1", question: "Why must both sides agree?", answer: "Because a limit is one value." },
		now: 5,
	});

	it("carries the question AND the answer (owner ruling), with a deterministic id", () => {
		assert.equal(marker.id, "steer_rdq_dx_1");
		assert.equal(marker.customType, "reading-discussion");
		assert.match(marker.content, /Reading discussion — beside the lesson/);
		assert.match(marker.content, /“Limits, properly” \(Deep dive\)/);
		assert.match(marker.content, /> the limit exists/);
		assert.match(marker.content, /> Why must both sides agree\?/);
		assert.match(marker.content, /> Because a limit is one value\./);
		assert.deepEqual(marker.details, { chatId: "c1", readingId: "rd_1", readingTitle: "Limits, properly", threadId: "dt_1", exchangeId: "dx_1" });
	});

	it("trims a very long answer", () => {
		const text = core.discussionMarkerText({ readingTitle: "T", readingKind: "recap", question: "q", answer: "a".repeat(core.MARKER_ANSWER_CHARS + 50) });
		assert.match(text, /\[…answer trimmed\]/);
	});

	it("the lesson shows a quiet line (never the Q&A); the model reads the text", () => {
		const view = projectView([marker as LhMessage]);
		assert.equal(view.length, 1);
		assert.deepEqual(
			view[0]!.parts.map((p) => p.type),
			["data-reading-discussion"],
		);
		const llm = toLlmMessages([marker as never]);
		assert.equal(llm.length, 1);
		assert.equal(llm[0]!.role, "user");
		assert.match(JSON.stringify(llm[0]!.content), /Why must both sides agree/);
	});
});

describe("the export's Discussion section", () => {
	it("is empty when nothing was asked", () => {
		assert.equal(core.discussionMarkdown(core.emptyDiscussion("rd_x", "2026-10-28T00:00:00Z")), "");
		assert.equal(core.discussionMarkdown(null), "");
	});

	it("lists passage threads (quoted) then the side chat; AI-only and unverified links are labeled", () => {
		const d = core.emptyDiscussion("rd_x", "2026-10-28T00:00:00Z");
		const x = (over: Partial<DiscussionExchange>): DiscussionExchange => ({ id: "x", question: "Q?", mode: "researched", status: "done", askedAt: "", ...over });
		d.threads.push({ id: "dt", passage: "the passage", exchanges: [x({ answer: "A [l](https://u.org/a)", unverifiedUrls: ["https://u.org/a"] })], createdAt: "" });
		d.side.exchanges.push(x({ mode: "model", answer: "Side answer." }), x({ status: "error", error: "Stopped", answer: undefined }));
		const md = core.discussionMarkdown(d);
		assert.match(md, /^## Discussion/);
		assert.match(md, /> the passage\n\n\*\*Q:\*\* Q\?\n\n\*\*A:\*\* A l \*\(unverified link\)\*/);
		assert.match(md, /### Side chat\n\n\*\*Q:\*\* Q\?\n\n\*\*A \(AI only — not source-checked\):\*\* Side answer\./);
		assert.match(md, /\*No answer: Stopped\.\*/);
	});
});

// ─── the store ──────────────────────────────────────────────────────────────

describe("the discussion store", () => {
	it("mutates atomically, refuses newer formats, deletes", () => {
		const id = "rd_store_1";
		assert.equal(readingDiscussionStore.getDiscussion(id), null);
		assert.equal(readingDiscussionStore.mutateDiscussion(id, () => null), null, "a null change writes nothing");
		const saved = readingDiscussionStore.mutateDiscussion(id, (cur) => cur ?? core.emptyDiscussion(id, "2026-01-01T00:00:00Z"))!;
		assert.equal(saved.readingId, id);
		assert.notEqual(saved.updatedAt, "2026-01-01T00:00:00Z", "updatedAt bumps");
		assert.ok(readingDiscussionStore.listDiscussions().some((r) => r.readingId === id));
		const file = path.join(TMP_DATA, "reading-discussions", `${id}.json`);
		fs.writeFileSync(file, JSON.stringify({ ...saved, version: 999 }));
		assert.equal(readingDiscussionStore.getDiscussion(id), null, "newer schema refused");
		assert.equal(readingDiscussionStore.deleteDiscussion(id), true);
		assert.equal(readingDiscussionStore.deleteDiscussion(id), false);
	});
});

// ─── the companion pipeline ─────────────────────────────────────────────────

describe("the companion pipeline", () => {
	const URL_OK = "https://example.org/limits";

	async function withFetchStub<T>(fn: () => Promise<T>): Promise<T> {
		const real = globalThis.fetch;
		globalThis.fetch = (async () => new Response("Synthetic page about limits.", { headers: { "content-type": "text/plain" } })) as typeof fetch;
		try {
			return await fn();
		} finally {
			globalThis.fetch = real;
		}
	}

	it("the prompt composes base, mode and the shared law; the task carries the reading, the passage and the thread", () => {
		assert.match(composeCompanionPrompt("researched"), /# The reading companion[\s\S]*researched mode/);
		assert.match(composeCompanionPrompt("model"), /model-knowledge mode/);
		const reading = readyReading();
		const text = companionTaskText(
			reading,
			{
				passage: "It measures a rate.",
				exchanges: [
					{ id: "x1", question: "First?", answer: "First answer.", mode: "model", status: "done", askedAt: "" },
					{ id: "x2", question: "And then?", mode: "model", status: "queued", askedAt: "" },
				],
			},
			{ id: "x2", question: "And then?", mode: "model" },
		);
		assert.match(text, /<reading>\n# Where the derivative comes from/);
		assert.match(text, /# The passage the learner selected\n\n> It measures a rate\./);
		assert.match(text, /# This thread so far\n\n\*\*Learner:\*\* First\?\n\n\*\*You:\*\* First answer\./);
		assert.match(text, /# The question now\n\nAnd then\?$/);
		assert.doesNotMatch(text, /transcript/i, "the transcript stays out");
	});

	it("researched: streams a live view, lists only fetched sources, marks the rest, reports done", async () => {
		const reading = readyReading({ anchor: { chatId: "c_any" } });
		const { threadId, exchangeId } = queueExchange(reading.id, { question: "Where do limits come from?", mode: "researched" });
		// The answer waits for the test to subscribe (the stream is the point).
		let open!: () => void;
		const gate = new Promise<void>((r) => (open = r));
		const engine = fauxEngine([
			fauxAssistantMessage([fauxToolCall("web_fetch", { url: URL_OK }, { id: "f1" })], { stopReason: "toolUse" }),
			async () => {
				await gate;
				return fauxAssistantMessage([fauxText(`From [the notes](${URL_OK}) — and [a guess](https://never.fetched/x).`)]);
			},
		]);
		const answered: string[] = [];
		const pipeline = createDiscussionPipeline({
			readingStore,
			discussionStore: readingDiscussionStore,
			engine,
			searchProvider: () => null,
			onAnswered: (_r, t, x) => answered.push(`${t.id}:${x.id}:${x.status}`),
		});
		const views: string[] = [];
		let settled = false;
		const running = withFetchStub(() => pipeline.run(reading.id, threadId, exchangeId));
		await waitFor(() => answerRunStatuses().some((r) => r.id === exchangeId), 2000, "the run registers");
		const sub = subscribeAnswer(exchangeId, (v) => (v === "settled" ? (settled = true) : views.push(v.text)));
		assert.ok(sub, "a live run is subscribable");
		open();
		await running;
		const x = exchangeOf(reading.id, exchangeId);
		assert.equal(x.status, "done", x.error);
		assert.match(x.answer!, /^From \[the notes\]/);
		assert.deepEqual(x.sources, [{ title: "the notes", url: URL_OK }]);
		assert.deepEqual(x.unverifiedUrls, ["https://never.fetched/x"]);
		assert.ok(x.usage && x.usage.steps >= 2, "usage accumulates per model call");
		assert.ok(settled, "subscribers hear settled");
		assert.ok(views.some((t) => t.length > 0 && t.length < x.answer!.length), "partial text streamed");
		assert.deepEqual(answered, [`${threadId}:${exchangeId}:done`]);
		assert.equal(subscribeAnswer(exchangeId, () => {}), null, "not live after settle");
		assert.equal(answerRunStatuses().length, 0);
	});

	it("model mode, a follow-up: the earlier exchange rides the task text", async () => {
		const reading = readyReading();
		const first = queueExchange(reading.id, { question: "What is a limit?", passage: "The derivative is a limit." });
		const engine = fauxEngine([fauxAssistantMessage([fauxText("A value approached.")]), fauxAssistantMessage([fauxText("Yes, from both sides.")])]);
		const pipeline = createDiscussionPipeline({ readingStore, discussionStore: readingDiscussionStore, engine });
		await pipeline.run(reading.id, first.threadId, first.exchangeId);
		const second = queueExchange(reading.id, { question: "From both sides?", threadId: first.threadId });
		await pipeline.run(reading.id, first.threadId, second.exchangeId);
		const x = exchangeOf(reading.id, second.exchangeId);
		assert.equal(x.status, "done", x.error);
		assert.equal(x.answer, "Yes, from both sides.");
		assert.equal(x.sources, undefined);
	});

	it("abort keeps the partial answer and settles as Stopped (no teacher marker)", async () => {
		const reading = readyReading();
		const { threadId, exchangeId } = queueExchange(reading.id, { question: "Long one?" });
		const engine = fauxEngine([
			(_ctx, _opts, state) =>
				new Promise((resolve) => {
					const sig = (state as { signal?: AbortSignal } | undefined)?.signal;
					setTimeout(() => resolve(fauxAssistantMessage("late")), 5_000);
					sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
				}),
		]);
		let answered = 0;
		const pipeline = createDiscussionPipeline({ readingStore, discussionStore: readingDiscussionStore, engine, onAnswered: () => answered++ });
		const running = pipeline.run(reading.id, threadId, exchangeId);
		for (let i = 0; i < 100 && !pipeline.abort(exchangeId); i++) await delay(10);
		await running;
		const x = exchangeOf(reading.id, exchangeId);
		assert.equal(x.status, "error");
		assert.equal(x.error, "Stopped");
		assert.equal(answered, 0);
	});

	it("BYOK: no model configured → the exchange errors honestly", async () => {
		const reading = readyReading();
		const { threadId, exchangeId } = queueExchange(reading.id, { question: "q" });
		const pipeline = createDiscussionPipeline({ readingStore, discussionStore: readingDiscussionStore, engineFor: () => undefined });
		assert.ok(pipeline.refusal());
		await pipeline.run(reading.id, threadId, exchangeId);
		const x = exchangeOf(reading.id, exchangeId);
		assert.equal(x.status, "error");
		assert.ok(x.error);
	});

	it("orphan settle: a stale record's live-looking exchanges become errors; a fresh one is left alone", () => {
		const pipeline = createDiscussionPipeline({ readingStore, discussionStore: readingDiscussionStore });
		const reading = readyReading();
		const { threadId, exchangeId } = queueExchange(reading.id, { question: "q" });
		const fresh = readingDiscussionStore.getDiscussion(reading.id)!;
		assert.equal(pipeline.settleIfOrphaned(fresh), fresh, "fresh: untouched");
		const stale: ReadingDiscussionRecord = { ...patchExchange(fresh, threadId, exchangeId, { status: "answering" }), updatedAt: new Date(Date.now() - 10 * 60_000).toISOString() };
		const settled = pipeline.settleIfOrphaned(stale);
		const x = settled.side.exchanges.find((e) => e.id === exchangeId)!;
		assert.equal(x.status, "error");
		assert.equal(x.error, "Interrupted (server restarted)");
	});
});

// ─── the server's ask rules ─────────────────────────────────────────────────

describe("askDiscussion (server)", async () => {
	const server = await import("../src/server/reading-discussions.ts");

	it("refuses an unknown reading (404) and a reading still being written (409)", () => {
		assert.throws(() => server.askDiscussion("rd_nope", { question: "q", mode: "model" }), (e: unknown) => (e as { status?: number }).status === 404);
		const writing = readyReading({ status: "writing" });
		assert.throws(() => server.askDiscussion(writing.id, { question: "q", mode: "model" }), (e: unknown) => (e as { status?: number }).status === 409);
	});

	it("without a configured model the ask is refused (503) and nothing is queued", () => {
		const reading = readyReading();
		assert.throws(() => server.askDiscussion(reading.id, { question: "q", mode: "model" }), (e: unknown) => (e as { status?: number }).status === 503);
		assert.equal(readingDiscussionStore.getDiscussion(reading.id), null);
	});

	it("getDiscussion: an empty discussion for a reading nothing was asked of; null for an unknown reading", () => {
		const reading = readyReading();
		const d = server.getDiscussion(reading.id)!;
		assert.equal(d.side.id, SIDE_THREAD_ID);
		assert.deepEqual(d.threads, []);
		assert.equal(server.getDiscussion("rd_nope"), null);
	});

	it("the reading's delete cascades to its discussion", async () => {
		const { deleteReading } = await import("../src/server/readings.ts");
		const reading = readyReading();
		queueExchange(reading.id, { question: "q" });
		assert.ok(readingDiscussionStore.getDiscussion(reading.id));
		assert.equal(deleteReading(reading.id), true);
		assert.equal(readingDiscussionStore.getDiscussion(reading.id), null);
	});
});

// ─── the held note (steer registry) ─────────────────────────────────────────

describe("the held note — never a wake", async () => {
	const jobs = await import("../src/server/jobs.ts");
	const { beginTurn, endTurn } = await import("../src/server/turn-liveness.ts");

	it("with no live run it parks (no wake fires); the next run takes it; settlement resolves it", async () => {
		const chat = chatStore.createChat("held note");
		let fired = 0;
		jobs.setTurnRunner(async () => {
			fired++;
			return 200;
		});
		const marker = core.buildDiscussionMarker({
			chatId: chat.id,
			readingId: "rd_h",
			readingTitle: "T",
			readingKind: "recap",
			thread: { id: SIDE_THREAD_ID },
			exchange: { id: "dx_held", question: "q", answer: "a" },
		});
		let resolved = false;
		const delivery = jobs.deliverHeldNote(marker).then(() => (resolved = true));
		await delay(1500);
		assert.equal(fired, 0, "an idle chat is never woken for a held note");
		assert.equal(resolved, false);

		// The learner's next run: registration hands the note to it.
		const handed: unknown[] = [];
		const agent = { steer: (m: unknown) => handed.push(m) };
		assert.ok(beginTurn(chat.id));
		jobs.registerLiveAgent(chat.id, agent as never);
		assert.equal(handed.length, 1);
		assert.equal((handed[0] as { id: string }).id, marker.id);

		// The run persisted it.
		jobs.unregisterLiveAgent(chat.id);
		jobs.settleSteers(chat.id, [marker as never]);
		endTurn(chat.id);
		await delivery;
		assert.ok(resolved);
		assert.equal(fired, 0, "still never a wake");
	});

	it("a run that ends without injecting it leaves it parked — still no wake", async () => {
		const chat = chatStore.createChat("held note, stranded");
		let fired = 0;
		jobs.setTurnRunner(async () => {
			fired++;
			return 200;
		});
		const marker = core.buildDiscussionMarker({
			chatId: chat.id,
			readingId: "rd_h2",
			readingTitle: "T",
			readingKind: "recap",
			thread: { id: SIDE_THREAD_ID },
			exchange: { id: "dx_held2", question: "q", answer: "a" },
		});
		void jobs.deliverHeldNote(marker);
		const handed: unknown[] = [];
		assert.ok(beginTurn(chat.id));
		jobs.registerLiveAgent(chat.id, { steer: (m: unknown) => handed.push(m) } as never);
		assert.equal(handed.length, 1);
		jobs.unregisterLiveAgent(chat.id);
		jobs.settleSteers(chat.id, []);
		endTurn(chat.id);
		await delay(1500);
		assert.equal(fired, 0);
		// The learner's next run picks it up again.
		const again: unknown[] = [];
		assert.ok(beginTurn(chat.id));
		jobs.registerLiveAgent(chat.id, { steer: (m: unknown) => again.push(m) } as never);
		assert.equal(again.length, 1);
		jobs.unregisterLiveAgent(chat.id);
		jobs.discardChatDeliveries(chat.id);
		endTurn(chat.id);
	});
});
