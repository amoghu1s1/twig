/**
 * THE CAPSTONE SURFACE (capstone sessions, 2026-11-01) — SSR render pins and
 * pure-logic pins: the transcript cards (brief / review / evaluate / gap
 * report), the core parse seam they read through, the seeded-start body
 * construction, the view's "Latest" evaluation flag, the sidebar row badge,
 * and the draft's capstone copy + create body.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import { BriefCard, EvaluateCard, GapReportCard, ReviewCard } from "../components/capstone-cards.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { CAPSTONE_PICK_HINT } from "../components/composer-actions.tsx";
import {
	parseBriefInput,
	parseEvaluateInput,
	parseGapReportInput,
	parseReviewInput,
	revisitTitle,
	seededSessionBody,
} from "../src/core/capstone-parts.ts";
import { projectView } from "../src/core/view.ts";
import { CAPSTONE_EVALUATE_TOOL, type LhMessage } from "../src/core/native-messages.ts";
import type { ArtifactPartProps, ChatListItem } from "../src/core";

const part = (type: string, over: Partial<ArtifactPartProps["part"]> = {}): ArtifactPartProps["part"] => ({
	type: `tool-${type}`,
	state: "output-available",
	toolCallId: "call_1",
	...over,
});

const VERDICTS = [
	{ criterion: "persists", status: "met", evidence: "src/store.ts:12 writes tasks.json" },
	{ criterion: "validates", status: "partial", evidence: "src/cli.ts:30 checks length only" },
	{ criterion: "errors", status: "unmet", evidence: "no error handling in src/" },
];
const GAPS = [
	{ area: "Input validation", note: "only length is checked", targets: ["n_1"] },
	{ area: "Error handling", note: "none present", targets: [] },
];

// ── the parse seam ───────────────────────────────────────────────────────────

describe("capstone parse seam", () => {
	it("parses well-formed inputs", () => {
		assert.equal(parseBriefInput({ title: "T", directory: "/p", criteria: [{ id: "a", text: "x" }] })?.criteria.length, 1);
		assert.equal(parseReviewInput({ summary: "s", verdicts: VERDICTS })?.verdicts.length, 3);
		assert.equal(parseEvaluateInput({ observations: "o", verdicts: VERDICTS, gaps: GAPS })?.gaps.length, 2);
		assert.equal(parseGapReportInput({ summary: "s", gaps: GAPS })?.gaps.length, 2);
	});

	it("rejects non-objects and missing required fields", () => {
		assert.equal(parseBriefInput(null), undefined);
		assert.equal(parseBriefInput("x"), undefined);
		assert.equal(parseBriefInput({ title: "T" }), undefined);
		assert.equal(parseReviewInput({ verdicts: [] }), undefined);
		assert.equal(parseEvaluateInput({ verdicts: [] }), undefined);
		assert.equal(parseGapReportInput([]), undefined);
	});

	it("drops malformed rows instead of crashing", () => {
		const r = parseReviewInput({
			summary: "s",
			verdicts: [VERDICTS[0], { criterion: "x", status: "great", evidence: "e" }, null, { criterion: "y" }],
		});
		assert.deepEqual(r?.verdicts.map((v) => v.criterion), ["persists"]);
		const g = parseGapReportInput({ summary: "s", gaps: [{ area: "a", note: "n", targets: ["t", 5] }, { note: "n" }] });
		assert.deepEqual(g?.gaps, [{ area: "a", note: "n", targets: ["t"] }]);
	});
});

// ── seeded start ─────────────────────────────────────────────────────────────

describe("seeded start", () => {
	const nodes = [
		{ id: "n_1", name: "Validation", statement: "Input must be checked at the boundary." },
		{ id: "n_2", name: "Errors", statement: "Failures are values." },
	];
	const gaps = [
		{ area: "Input validation", note: "n", targets: ["n_1", "n_missing"] },
		{ area: "Error handling", note: "n", targets: ["n_2", "n_1"] },
	];

	it("revisitTitle lists the first four areas and elides the rest", () => {
		assert.equal(revisitTitle([{ area: "A" }, { area: "B" }]), "Revisit: A, B");
		assert.equal(
			revisitTitle(["A", "B", "C", "D", "E"].map((area) => ({ area }))),
			"Revisit: A, B, C, D, …",
		);
	});

	it("teach: no kind, graphContext = the tagged propositions that exist, once each", () => {
		const body = seededSessionBody("teach", gaps, nodes);
		assert.equal("kind" in body, false);
		assert.equal(body.title, "Revisit: Input validation, Error handling");
		assert.deepEqual(body.graphContext?.propositions.map((p) => p.id), ["n_1", "n_2"]);
		assert.equal(body.graphContext?.propositions[0]?.statement, "Input must be checked at the boundary.");
	});

	it("practice carries kind: practice", () => {
		assert.equal(seededSessionBody("practice", gaps, nodes).kind, "practice");
	});

	it("no tagged gaps (or none in the graph) start pickless", () => {
		const body = seededSessionBody("teach", [{ area: "A", note: "n", targets: [] }], nodes);
		assert.equal("graphContext" in body, false);
		assert.equal("graphContext" in seededSessionBody("teach", [{ area: "A", note: "n", targets: ["zzz"] }], nodes), false);
	});
});

// ── the cards ────────────────────────────────────────────────────────────────

describe("capstone cards", () => {
	it("BriefCard shows the title, directory and every criterion", () => {
		const html = renderToStaticMarkup(
			<BriefCard part={part("brief", { input: { title: "Task CLI", directory: "/home/u/tasks", criteria: [{ id: "persists", text: "Saves to a file" }, { id: "validates", text: "Rejects bad input" }] } })} />,
		);
		assert.match(html, /data-testid="brief-card"/);
		assert.match(html, /Task CLI/);
		assert.match(html, /\/home\/u\/tasks/);
		assert.equal((html.match(/data-testid="brief-criterion"/g) ?? []).length, 2);
	});

	it("ReviewCard renders a chip per criterion with its evidence open", () => {
		const html = renderToStaticMarkup(<ReviewCard part={part("review", { input: { summary: "Half built.", verdicts: VERDICTS } })} />);
		assert.match(html, /Checkpoint review/);
		assert.equal((html.match(/data-testid="verdict-row"/g) ?? []).length, 3);
		for (const status of ["met", "partial", "unmet"]) assert.match(html, new RegExp(`data-status="${status}"`));
		assert.match(html, /bg-success\/15/);
		assert.match(html, /bg-warning\/15/);
		assert.match(html, /bg-error\/15/);
		assert.match(html, /src\/store\.ts:12 writes tasks\.json/);
	});

	it("EvaluateCard shows observations, gaps and the seed buttons; 'Latest' only when flagged", () => {
		const input = { verdicts: VERDICTS, observations: "Solid storage layer.", gaps: GAPS };
		const latest = renderToStaticMarkup(<EvaluateCard part={part("evaluate", { input, latest: true })} />);
		assert.match(latest, /data-latest="true"/);
		assert.match(latest, />Latest</);
		assert.match(latest, /Solid storage layer\./);
		assert.equal((latest.match(/data-testid="gap-row"/g) ?? []).length, 2);
		assert.match(latest, /data-testid="seed-teach"/);
		assert.match(latest, /data-testid="seed-practice"/);
		const older = renderToStaticMarkup(<EvaluateCard part={part("evaluate", { input })} />);
		assert.doesNotMatch(older, />Latest</);
	});

	it("EvaluateCard with no gaps has no Gaps section and no seed buttons", () => {
		const html = renderToStaticMarkup(
			<EvaluateCard part={part("evaluate", { input: { verdicts: VERDICTS, observations: "All held.", gaps: [] } })} />,
		);
		assert.doesNotMatch(html, /Gaps/);
		assert.doesNotMatch(html, /seed-teach/);
	});

	it("GapReportCard renders the summary, gaps and both seed buttons", () => {
		const html = renderToStaticMarkup(<GapReportCard part={part("gap_report", { input: { summary: "Not ready to build.", gaps: GAPS } })} />);
		assert.match(html, /data-testid="gap-report-card"/);
		assert.match(html, /Not ready to build\./);
		assert.match(html, /Teach these/);
		assert.match(html, /Practice these/);
	});

	it("a refused call falls back to the quiet tool-call card, never a brief/verdict", () => {
		const html = renderToStaticMarkup(
			<BriefCard part={part("brief", { state: "output-error", input: { title: "T", directory: "/p", criteria: [{ id: "a", text: "x" }] } })} />,
		);
		assert.match(html, /data-testid="tool-call-card"/);
		assert.doesNotMatch(html, /brief-card/);
	});

	it("malformed input renders nothing (no crash)", () => {
		assert.equal(renderToStaticMarkup(<BriefCard part={part("brief", { input: { title: 5 } })} />), "");
		assert.equal(renderToStaticMarkup(<EvaluateCard part={part("evaluate", { input: "garbage" })} />), "");
	});
});

// ── the view's Latest flag ───────────────────────────────────────────────────

const STAMPS = {
	api: "faux", provider: "test", model: "m",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
} as const;

function evaluateTurn(n: number, isError = false): LhMessage[] {
	const call: LhMessage & AssistantMessage = {
		id: `a${n}`, role: "assistant", timestamp: n, ...STAMPS,
		content: [{ type: "toolCall", id: `call_${n}`, name: CAPSTONE_EVALUATE_TOOL, arguments: { verdicts: VERDICTS, observations: "o", gaps: [] } }],
	};
	const result: LhMessage & ToolResultMessage = {
		id: `r${n}`, role: "toolResult", toolCallId: `call_${n}`, toolName: CAPSTONE_EVALUATE_TOOL,
		content: [{ type: "text", text: "x" }], details: null, isError, timestamp: n,
	};
	return [call, result];
}

describe("projectView capstone 'latest' evaluation", () => {
	const flags = (messages: LhMessage[]) =>
		projectView(messages).flatMap((m) => m.parts).filter((p) => p.type === "tool-evaluate").map((p) => p.latest === true);

	it("flags only the newest evaluation that went through", () => {
		assert.deepEqual(flags([...evaluateTurn(1), ...evaluateTurn(2)]), [false, true]);
	});

	it("skips a refused newer evaluation", () => {
		assert.deepEqual(flags([...evaluateTurn(1), ...evaluateTurn(2, true)]), [true, false]);
	});

	it("does not flag a dangling evaluation that never went through", () => {
		assert.deepEqual(flags([...evaluateTurn(1), ...evaluateTurn(2).slice(0, 1)]), [true, false]);
	});
});

// ── sidebar row, draft shell, create body ────────────────────────────────────

function item(over: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1", title: "T", kind: "teach", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 1, phase: "probe", pendingQuestion: false, pendingProblem: false, busy: false, compacting: false, ...over,
	};
}

describe("capstone sidebar row", () => {
	it("a capstone row carries the hammer badge; others do not", () => {
		assert.match(renderToStaticMarkup(<SessionRow chat={item({ kind: "capstone" })} active={false} onOpen={() => {}} />), /aria-label="Capstone session"/);
		assert.doesNotMatch(renderToStaticMarkup(<SessionRow chat={item({ kind: "practice" })} active={false} onOpen={() => {}} />), /Capstone session/);
	});
});

describe("capstone draft", () => {
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	beforeEach(() => {
		const data = new Map<string, string>();
		Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
			getItem: (k: string) => data.get(k) ?? null,
			setItem: (k: string, v: string) => { data.set(k, v); },
			removeItem: (k: string) => { data.delete(k); },
		} });
	});
	afterEach(() => {
		if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
		else Reflect.deleteProperty(globalThis, "sessionStorage");
	});

	it("empty state and pick pill say picks are required", () => {
		const html = renderToStaticMarkup(<InteractionLayersProvider><DraftShell busy={false} text="" onChange={() => {}} onSend={() => {}} mode="capstone" picks={[]} /></InteractionLayersProvider>);
		assert.match(html, /New capstone/);
		assert.match(html, /pitch what you would build/);
		assert.ok(html.includes(CAPSTONE_PICK_HINT));
		assert.match(html, /What would you build\?/);
	});

	it("send is disabled with text but no picks, enabled once a node is picked", () => {
		const off = renderToStaticMarkup(<InteractionLayersProvider><DraftShell busy={false} text="a task cli" onChange={() => {}} onSend={() => {}} mode="capstone" picks={[]} /></InteractionLayersProvider>);
		const on = renderToStaticMarkup(
			<InteractionLayersProvider><DraftShell busy={false} text="a task cli" onChange={() => {}} onSend={() => {}} mode="capstone" picks={[{ id: "n_1", name: "N", statement: "S" }]} /></InteractionLayersProvider>,
		);
		const sendButton = (html: string) => /<button[^>]*aria-label="Send"[^>]*>/.exec(html)?.[0] ?? "";
		assert.match(sendButton(off), /\sdisabled(=|\s|>)/);
		assert.doesNotMatch(sendButton(on), /\sdisabled(=|\s|>)/);
		assert.ok(on.includes("1 node selected"));
	});

	it("startDraftSession sends kind: capstone with the picks as graphContext", async () => {
		const calls: unknown[] = [];
		const f = (async (_u: string, init?: RequestInit) => {
			calls.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ id: "c_cap" }), { status: 200 });
		}) as typeof fetch;
		const picks = [{ id: "n_1", name: "N", statement: "S" }];
		assert.equal(await startDraftSession("a task cli", f, "capstone", picks), "/chat/c_cap");
		assert.deepEqual(calls[0], { title: "a task cli", kind: "capstone", graphContext: { propositions: picks } });
	});
});
