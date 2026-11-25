import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { sessionFindEntries, type CollapsedSearchSource } from "../components/session-find-dom.ts";
import { extractSessionHeadings, extractSessionQuestions } from "../components/session-outline.tsx";
import { extractSessionTurns } from "../components/session-turn-rail.tsx";
import type { LhViewMessage } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
(globalThis as Record<string, unknown>).window = dom.window;
(globalThis as Record<string, unknown>).document = dom.document;

describe("sessionFindEntries with collapsed side-chats and collapsed cards", () => {
	it("merges visible DOM matches and collapsed hidden-body matches in DOM order", () => {
		const { document } = parseHTML(`
			<div id="scope" data-session-find-root="">
				<p>First Jacobian paragraph.</p>
				<button data-side-window="side_1" data-testid="side-chat-bar" aria-expanded="false">“slope at a point”</button>
				<p>Middle text.</p>
				<button data-answered-card="card_1" data-testid="answered-card-bar" aria-expanded="false">Check: Question one</button>
				<p>Final Jacobian summary.</p>
			</div>
		`);
		const scope = document.getElementById("scope") as unknown as HTMLElement;
		const collapsed: CollapsedSearchSource[] = [
			{
				kind: "collapsed-side",
				key: "side_1",
				selector: '[data-side-window="side_1"]',
				texts: ["The Jacobian scales volume elements."],
			},
			{
				kind: "collapsed-card",
				key: "card_1",
				selector: '[data-answered-card="card_1"]',
				texts: ["Because the Jacobian determinant is non-zero."],
			},
		];

		const entries = sessionFindEntries(scope, "jacobian", collapsed);
		assert.deepEqual(
			entries.map((e) => (e.kind === "dom" ? `dom:${e.range.toString()}` : `${e.kind}:${e.key}`)),
			["dom:Jacobian", "collapsed-side:side_1", "collapsed-card:card_1", "dom:Jacobian"],
		);
	});

	it("ignores collapsed source when element is already expanded", () => {
		const { document } = parseHTML(`
			<div id="scope" data-session-find-root="">
				<section data-side-window="side_1" aria-expanded="true">
					<p>Visible Jacobian answer.</p>
				</section>
			</div>
		`);
		const scope = document.getElementById("scope") as unknown as HTMLElement;
		const collapsed: CollapsedSearchSource[] = [
			{
				kind: "collapsed-side",
				key: "side_1",
				selector: '[data-side-window="side_1"]',
				texts: ["Visible Jacobian answer."],
			},
		];
		const entries = sessionFindEntries(scope, "jacobian", collapsed);
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.kind, "dom");
	});
});

describe("session outline & turn rail extractors", () => {
	const messages: LhViewMessage[] = [
		{ id: "u1", role: "user", parts: [{ type: "text", text: "Teach me Green's theorem." }] },
		{
			id: "a1",
			role: "assistant",
			parts: [
				{
					type: "text",
					id: "msg_a1-t0",
					text: "## Line Integrals\n\n```md\n# Not a heading\n```\n\n### Circulation Density\nBody text.",
				},
				{
					type: "tool-quiz",
					state: "output-available",
					toolCallId: "q1",
					output: {
						kind: "quiz",
						tool: "quiz",
						questionType: "predict",
						questionText: "Sign of circulation?",
						dontKnow: false,
						answers: [],
						correct: true,
						answeredAt: "",
					},
				},
			],
		},
	];

	it("extracts headings while ignoring fenced code blocks", () => {
		const headings = extractSessionHeadings(messages);
		assert.deepEqual(
			headings.map((h) => ({ level: h.level, text: h.text, messageId: h.messageId, idx: h.indexInMessage })),
			[
				{ level: 2, text: "Line Integrals", messageId: "msg_a1", idx: 0 },
				{ level: 3, text: "Circulation Density", messageId: "msg_a1", idx: 1 },
			],
		);
	});

	it("extracts answered questions and visible turns", () => {
		const questions = extractSessionQuestions(messages);
		assert.equal(questions.length, 1);
		assert.equal(questions[0]!.kindLabel, "Prediction");
		assert.equal(questions[0]!.badge, "correct");

		const turns = extractSessionTurns(messages);
		assert.equal(turns.length, 2);
		assert.equal(turns[0]!.role, "user");
		assert.equal(turns[1]!.label, "Line Integrals");
	});
});
