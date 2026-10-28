/**
 * READINGS UI pins (docs/readings.md §6/§8) — static renders: the
 * teacher's offer card (outside a session it renders the offer without
 * controls; a refused call renders nothing), the chain table's Deep dive
 * action (only beside the delete fence, never in practice-pick mode), and
 * the portable markdown export.
 */

import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { ReadingOfferCard } from "../components/readings/offer-card.tsx";
import { ChainTableBody } from "../components/chain-table.tsx";
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
