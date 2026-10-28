/**
 * READINGS UI pins (docs/readings.md §6/§8) — static renders: the
 * teacher's offer card (outside a session it renders the offer without
 * controls; a refused call renders nothing), the chain table's Deep dive
 * action (only beside the delete fence, never in practice-pick mode), the
 * overview's sections with their live plan-node chips, and the portable
 * markdown export.
 */

import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { ReadingOfferCard } from "../components/readings/offer-card.tsx";
import { ChainTableBody } from "../components/chain-table.tsx";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ReadingDocument } from "../components/readings/reading-view.tsx";
import type { FullReading } from "../components/readings/api.ts";
import { readingMarkdown } from "../src/core/readings.ts";
import type { GraphNode } from "../src/core/contracts.ts";

describe("the reading offer card", () => {
	const part = (state: string) => ({
		type: "tool-suggest_reading",
		state,
		toolCallId: "call-1",
		input: { kind: "deep-dive", planNodeId: "n", title: "Where it came from", why: "A detour worth taking." },
	});

	it("renders the offer; without a session seam there are no controls", () => {
		const html = renderToStaticMarkup(React.createElement(ReadingOfferCard, { part: part("output-available") }));
		assert.match(html, /data-testid="reading-offer"/);
		assert.match(html, /Where it came from/);
		assert.match(html, /Optional reading · Deep dive/);
		assert.doesNotMatch(html, /reading-offer-accept/);
	});

	it("a refused call renders nothing", () => {
		assert.equal(renderToStaticMarkup(React.createElement(ReadingOfferCard, { part: part("output-error") })), "");
	});
});

describe("the chain table's Deep dive", () => {
	const node: GraphNode = { id: "n_1", name: "Chain rule", statement: "s", aliases: [], createdAt: "2026-01-01", provenance: [{ chatId: "c1", messageId: "m" }] };
	const base = {
		nodes: [node],
		chains: [],
		sessions: {},
		fileSources: {},
		query: "",
		onQuery: () => {},
		sort: { col: "name" as const, dir: 1 as const },
		onSort: () => {},
		selection: new Set(["n_1"]),
		expandedClusters: new Set<string>(),
		expandedChains: new Set<string>(),
		onToggleCluster: () => {},
		onToggleChain: () => {},
		onToggleNodes: () => {},
		onClear: () => {},
		onDelete: () => {},
		onClose: () => {},
		selectedSources: new Set(["c1"]),
	};

	it("sits beside the delete fence when sources are selected", () => {
		const html = renderToStaticMarkup(React.createElement(ChainTableBody, { ...base, onDeepDive: () => {} }));
		assert.match(html, /data-testid="chain-deep-dive"/);
	});

	it("is absent in practice-pick mode", () => {
		const html = renderToStaticMarkup(React.createElement(ChainTableBody, { ...base, onDeepDive: () => {}, selectMode: true, onSelect: () => {} }));
		assert.doesNotMatch(html, /chain-deep-dive/);
	});

	it("is absent when the selected sources hold no propositions", () => {
		const html = renderToStaticMarkup(React.createElement(ChainTableBody, { ...base, selectedSources: new Set(["other"]), onDeepDive: () => {} }));
		assert.doesNotMatch(html, /chain-deep-dive/);
	});
});

describe("an overview's sections", () => {
	const reading: FullReading = {
		id: "rd_1",
		kind: "overview",
		mode: "model",
		status: "ready",
		title: "The map of calculus",
		anchor: { chatId: "c1" },
		snapshot: { planNodes: [{ id: "limits", title: "Limits" }, { id: "gone", title: "Old node" }] },
		body: "Intro.",
		sections: [
			{ heading: "Why it exists", body: "Motivation." },
			{ heading: "Limits", body: "The base.", planNodeIds: ["limits", "gone"] },
		],
		createdAt: "2026-10-27T00:00:00Z",
		updatedAt: "2026-10-27T00:00:00Z",
		costUsd: null,
		practice: [],
		planStatus: { limits: "visited" },
	};

	it("renders each section with its plan nodes' live status; a node gone from the plan offers no deep dive", () => {
		// The reader's actions navigate; a static render needs a router mounted.
		const router = { push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} };
		const html = renderToStaticMarkup(
			React.createElement(AppRouterContext.Provider, { value: router as never }, React.createElement(ReadingDocument, { reading })),
		);
		assert.equal(html.match(/data-testid="reading-section"/g)?.length, 2);
		assert.match(html, /Why it exists/);
		assert.match(html, /data-status="visited"/);
		assert.match(html, /· Visited/);
		assert.match(html, /data-status="gone"/);
		assert.equal(html.match(/data-testid="reading-node-deeper"/g)?.length, 1);
	});

	it("exports the sections with their nodes' titles", () => {
		const md = readingMarkdown(reading);
		assert.match(md, /\*Overview · /);
		assert.match(md, /## Limits\n\n\*In your lesson: Limits, Old node\*\n\nThe base\./);
	});
});

describe("the markdown export", () => {
	it("carries the body, the glossary, sources, and further reading — and labels AI-only honestly", () => {
		const md = readingMarkdown({
			title: "T",
			kind: "recap",
			mode: "model",
			body: "Body.",
			terms: [{ term: "A", definition: "B" }],
			sources: [{ title: "S", url: "https://s.org" }],
			furtherReading: [{ title: "F", url: "https://f.org", why: "W", level: "intro" }],
			createdAt: "2026-10-27T00:00:00Z",
		});
		assert.match(md, /^# T/);
		assert.match(md, /not source-checked/);
		assert.match(md, /\*\*A\*\* — B/);
		assert.match(md, /1\. \[S\]\(https:\/\/s\.org\)/);
		assert.match(md, /- \[F\]\(https:\/\/f\.org\) \*\(intro\)\* — W/);
	});
});
