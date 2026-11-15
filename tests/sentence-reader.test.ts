import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { AssistantTextResponse } from "../components/ai-elements/message.tsx";
import {
	clampReaderStep,
	DEFAULT_READER_PREFS,
	latestReadablePassage,
	latestReadablePassageTarget,
	parseReaderPrefs,
	readerPassageKey,
	speechText,
	splitReaderUnits,
} from "../src/core/sentence-reader.ts";
import { alignReaderGroupAnchors, readerFontStyle } from "../components/sentence-reader.tsx";
import type { LhViewMessage, LhViewPart } from "../src/core/view.ts";

describe("readerFontStyle", () => {
	it("writes the prose-size token, not a parent font-size the prose class overrides", () => {
		const style = readerFontStyle(28) as Record<string, string>;
		assert.equal(style["--lh-prose-size"], "28px");
		assert.equal(style["--lh-prose-leading"], "1.9");
	});
});

describe("splitReaderUnits", () => {
	it("splits a paragraph into inline sentence steps", () => {
		const u = splitReaderUnits("First idea. Second idea! Third?\n\nNew paragraph here.");
		assert.deepEqual(u.map((x) => x.markdown), ["First idea.", "Second idea!", "Third?", "New paragraph here."]);
		assert.deepEqual(u.map((x) => x.startsBlock), [true, false, false, true]);
		assert.ok(u.every((x) => x.inline));
	});

	it("never breaks inside inline math or code", () => {
		const u = splitReaderUnits("Let $x = 1.5. y$ hold. Use `a. b` too.");
		assert.deepEqual(u.map((x) => x.markdown), ["Let $x = 1.5. y$ hold.", "Use `a. b` too."]);
	});

	it("keeps fences and display math whole", () => {
		const u = splitReaderUnits("Before.\n\n```py\nx = 1.\n\ny = 2.\n```\n\n$$\na.\n\nb\n$$\n\nAfter.");
		assert.equal(u.length, 4);
		assert.ok(u[1]!.markdown.startsWith("```py") && !u[1]!.inline);
		assert.ok(u[2]!.markdown.startsWith("$$"));
	});

	it("makes headings and list items their own block steps", () => {
		const u = splitReaderUnits("## Title\n\n- one. two.\n- three");
		assert.deepEqual(u.map((x) => x.markdown), ["## Title", "- one. two.", "- three"]);
		assert.ok(u.every((x) => !x.inline));
	});

	it("segments Chinese sentences", () => {
		const u = splitReaderUnits("先按顺序数。再除掉重复。");
		assert.equal(u.length, 2);
	});

	it("empty input has no steps", () => {
		assert.deepEqual(splitReaderUnits("  \n\n "), []);
	});

	it("keeps callout blockquotes with display math and \\boxed LaTeX intact as one unit", () => {
		const md = [
			"Intro.",
			"",
			"> [!IMPORTANT]",
			"> **Cross product from determinants:**",
			"> $$\\boxed{\\mathbf{u} \\times \\mathbf{v} = \\begin{vmatrix} \\mathbf{i} & \\mathbf{j} & \\mathbf{k} \\\\ u_1 & u_2 & u_3 \\\\ v_1 & v_2 & v_3 \\end{vmatrix}}$$",
			"",
			"> [!NOTE]",
			"> $$",
			"> \\boxed{x = 1.5}",
			"> $$",
			"",
			"Look at \\[ \\boxed{y = 2.5} \\] too.",
		].join("\n");
		const u = splitReaderUnits(md);
		assert.equal(u.length, 4);
		assert.equal(u[0]!.markdown, "Intro.");
		assert.match(u[1]!.markdown, /^> \[!IMPORTANT\]\n> \*\*Cross product/);
		assert.equal(u[1]!.inline, false);
		assert.match(u[2]!.markdown, /^> \[!NOTE\]\n> \$\$\n> \\boxed\{x = 1\.5\}\n> \$\$$/);
		assert.equal(u[2]!.inline, false);
		assert.equal(u[3]!.markdown, "Look at \\[ \\boxed{y = 2.5} \\] too.");

		const calloutHtml = renderToStaticMarkup(React.createElement(AssistantTextResponse, null, u[1]!.markdown));
		assert.match(calloutHtml, /data-testid="md-callout"/);
		assert.match(calloutHtml, /class="[^"]*katex/);
		assert.doesNotMatch(calloutHtml, /\[!IMPORTANT\]/);
		assert.doesNotMatch(calloutHtml, /katex-error/);

		const overescapedUnit = splitReaderUnits("$$\\\\boxed{\\\\frac{a}{b}}$$")[0]!;
		const overescapedHtml = renderToStaticMarkup(React.createElement(AssistantTextResponse, null, overescapedUnit.markdown));
		assert.match(overescapedHtml, /class="[^"]*katex/);
		assert.doesNotMatch(overescapedHtml, /katex-error/);
	});
});

describe("speechText", () => {
	it("strips markdown and replaces math/code", () => {
		assert.equal(speechText("## **Big** idea with $x^2$ and [a link](http://z)"), "Big idea with formula and a link");
		assert.equal(speechText("- item `code`"), "item code");
	});

	it("strips GitHub callout markers and \\[...\\] display math", () => {
		assert.equal(speechText("> [!IMPORTANT]\n> **Rule:**\n> $$x = 1$$"), "Rule: formula");
		assert.equal(speechText("Look at \\[ \\boxed{x = 1} \\] now."), "Look at formula now.");
	});
});

describe("parseReaderPrefs", () => {
	it("defaults on null or corrupt input", () => {
		assert.deepEqual(parseReaderPrefs(null), DEFAULT_READER_PREFS);
		assert.deepEqual(parseReaderPrefs("{nope"), DEFAULT_READER_PREFS);
	});

	it("the browser voice is the default — ElevenLabs is opt-in", () => {
		assert.equal(DEFAULT_READER_PREFS.cloud, false);
		const p = parseReaderPrefs(JSON.stringify({ cloud: true }));
		assert.equal(p.cloud, true);
		assert.equal(parseReaderPrefs(JSON.stringify({ cloud: "yes" })).cloud, DEFAULT_READER_PREFS.cloud);
	});

	it("clamps numbers and rejects unknown values per field", () => {
		const p = parseReaderPrefs(JSON.stringify({ style: "hide", fontSize: 99, rate: 0.1, autoRead: "yes" }));
		assert.equal(p.style, "hide");
		assert.equal(p.fontSize, 32);
		assert.equal(p.rate, 0.7);
		assert.equal(p.voice, DEFAULT_READER_PREFS.voice);
		assert.equal(p.autoRead, false);
	});
});

describe("latestReadablePassage — what the reader shortcut opens", () => {
	const text = (t: string, id?: string): LhViewPart => ({ type: "text", text: t, ...(id ? { id } : {}) });
	const tool: LhViewPart = { type: "tool-probe" };
	const teacher = (id: string, ...parts: LhViewPart[]): LhViewMessage => ({ id, role: "assistant", parts });
	const learner = (id: string, t: string): LhViewMessage => ({ id, role: "user", parts: [text(t)] });

	it("takes the last text part of the newest teacher message", () => {
		const messages = [teacher("a", text("old", "a-t0")), learner("u", "hi"), teacher("b", text("first", "b-t0"), tool, text("second", "b-t2"), tool)];
		assert.equal(latestReadablePassage(messages, false), "second");
		assert.deepEqual(latestReadablePassageTarget(messages, false), { text: "second", partId: "b-t2" });
	});

	it("looks past a newest message that only holds tool calls", () => {
		const messages = [teacher("a", text("the lesson")), learner("u", "ok"), teacher("b", tool)];
		assert.equal(latestReadablePassage(messages, false), "the lesson");
	});

	it("skips blank text and never reads the learner's own words", () => {
		const messages = [teacher("a", text("real")), teacher("b", text("  \n"), tool), learner("u", "mine")];
		assert.equal(latestReadablePassage(messages, false), "real");
	});

	it("returns null for no teacher text at all", () => {
		assert.equal(latestReadablePassage([], false), null);
		assert.equal(latestReadablePassage([learner("u", "hello"), teacher("a", tool)], false), null);
	});

	it("while streaming, the passage being written is not readable — and no older one stands in", () => {
		const messages = [teacher("a", text("old")), teacher("b", tool, text("being writ"))];
		assert.equal(latestReadablePassage(messages, true), null);
		assert.equal(latestReadablePassage(messages, false), "being writ");
	});

	it("while streaming, a finished passage before the live tail is still readable", () => {
		const messages = [teacher("a", text("done"), tool, text("")), learner("u", "x")];
		assert.equal(latestReadablePassage(messages, true), "done");
	});
});

describe("reader progress helpers and side-chat block alignment", () => {
	it("readerPassageKey prefers partId when provided and hashes text deterministically otherwise", () => {
		assert.equal(readerPassageKey("Hello.", "m1-t0"), "lh-reader-pos:m1-t0");
		const a = readerPassageKey("First passage.");
		const b = readerPassageKey("First passage.");
		const c = readerPassageKey("Second passage.");
		assert.match(a, /^lh-reader-pos:[0-9a-f]{8}$/);
		assert.equal(a, b);
		assert.notEqual(a, c);
	});

	it("clampReaderStep defaults to step 1 and clamps between 1 and total", () => {
		assert.equal(clampReaderStep(null, 5), 1);
		assert.equal(clampReaderStep(undefined, 5), 1);
		assert.equal(clampReaderStep(0, 5), 1);
		assert.equal(clampReaderStep(3, 5), 3);
		assert.equal(clampReaderStep(12, 5), 5);
		assert.equal(clampReaderStep(3, 0), 0);
	});

	it("alignReaderGroupAnchors aligns reader groups with Streamdown block indices", () => {
		const md = "Intro. Second sentence.\n\n- Item one\n- Item two\n\nOutro.";
		const units = splitReaderUnits(md);
		const groups: number[][] = [];
		units.forEach((u, i) => {
			if (u.startsBlock || groups.length === 0) groups.push([i]);
			else groups[groups.length - 1]!.push(i);
		});
		const anchors = alignReaderGroupAnchors(md, "msg_1", "msg_1-t0", groups, units);
		assert.equal(anchors.length, 4);
		assert.ok(anchors[0]!.blockIndex < anchors[1]!.blockIndex);
		assert.equal(anchors[1]!.blockIndex, anchors[2]!.blockIndex, "list items share Streamdown list block index");
		assert.ok(anchors[2]!.blockIndex < anchors[3]!.blockIndex);
	});
});
