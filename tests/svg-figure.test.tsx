/**
 * Hand-drawn ```svg figures: the pure preparation (theme ink, namespace,
 * refusals), the markdown path (static and mounted), and the drawing rules
 * the side chat and the tutor are given.
 * (tsx uses the classic JSX transform, hence the React global shim.)
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { MarkdownCode } from "../components/md-blocks.tsx";
import { FIGURE_STAGE_INK, SVG_FIGURE_MAX_CHARS, figureDisplayWidth, prepareSvgFigure } from "../components/svg-figure.ts";

const TRIANGLE =
	'<svg viewBox="0 0 300 200" xmlns="http://www.w3.org/2000/svg"><polygon points="20,180 280,180 280,20" fill="none" stroke="currentColor"/><text x="150" y="196">0.5</text></svg>';

describe("preparing a figure", () => {
	it("gives the root the theme's ink, so currentColor and unfilled text follow the theme", () => {
		const svg = prepareSvgFigure(TRIANGLE, "rgb(230, 230, 230)")!;
		assert.ok(svg.startsWith('<svg viewBox="0 0 300 200" xmlns="http://www.w3.org/2000/svg"><style>svg{color:rgb(230, 230, 230);'));
		// The root fills with the ink unless it sets a fill itself; a group's
		// own fill still reaches its children.
		assert.match(svg, /svg:not\(\[fill\]\):not\(\[style\*="fill"\]\)\{fill:currentColor\}/);
		assert.ok(svg.endsWith('<text x="150" y="196">0.5</text></svg>'), "the drawing itself is untouched");
	});

	it("adds the namespace an image needs, and tolerates a prolog, doctype or comments around it", () => {
		const source = '<?xml version="1.0"?>\n<!DOCTYPE svg>\n<!-- the unit circle -->\n<svg viewBox="0 0 10 10"><circle r="4"/></svg>\n<!-- end -->\n';
		const svg = prepareSvgFigure(source, "#eee")!;
		assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>'));
		assert.ok(svg.endsWith("<circle r=\"4\"/></svg>"));
	});

	it("shows a math-unit viewBox at a default width, a pixel one at its own", () => {
		assert.equal(figureDisplayWidth(2.4), 360);
		assert.equal(figureDisplayWidth(440), 440);
	});

	it("refuses anything that isn't one whole <svg> element, or is too large", () => {
		for (const source of ["", "<div>hi</div>", "<svg/>", '<svg viewBox="0 0 1 1"><circle r="1"/>', `<svg>${"x".repeat(SVG_FIGURE_MAX_CHARS)}</svg>`]) {
			assert.equal(prepareSvgFigure(source, "#eee"), null, source.slice(0, 40));
		}
	});

	it("never writes an ink that could break out of the style element", () => {
		const svg = prepareSvgFigure(TRIANGLE, "red}</style><script>")!;
		assert.ok(svg.includes(`svg{color:${FIGURE_STAGE_INK};`));
		assert.ok(!svg.includes("<script>"));
	});
});

describe("```svg fences in markdown", () => {
	it("render as a figure (a placeholder until mounted), never as code, source never leaked", () => {
		const html = renderToStaticMarkup(<MessageResponse mode="static">{`Here:\n\n\`\`\`svg\n${TRIANGLE}\n\`\`\``}</MessageResponse>);
		assert.ok(html.includes('data-testid="md-svg"'));
		assert.ok(!html.includes('data-streamdown="code-block"'));
		assert.ok(!html.includes("polygon"));
	});
});

describe("a mounted figure", () => {
	const dom = parseHTML("<html><body></body></html>");
	const saved = { ...globalThis } as Record<string, unknown>;
	let root: Root | undefined;

	async function mount(source: string, inButton = false) {
		Object.assign(globalThis, {
			window: dom.window,
			document: dom.document,
			Element: dom.window.Element,
			HTMLElement: dom.window.HTMLElement,
			MutationObserver: dom.window.MutationObserver,
			IS_REACT_ACT_ENVIRONMENT: true,
			getComputedStyle: () => ({ color: "rgb(1, 2, 3)" }),
		});
		const host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		root = createRoot(host);
		const figure = <MarkdownCode data-block="" className="language-svg">{source}</MarkdownCode>;
		await act(async () => root!.render(inButton ? <button type="button">{figure}</button> : figure));
		return host;
	}

	afterEach(async () => {
		await act(async () => root?.unmount());
		root = undefined;
		for (const key of ["window", "document", "Element", "HTMLElement", "MutationObserver", "getComputedStyle"]) {
			if (key in saved) (globalThis as Record<string, unknown>)[key] = saved[key];
			else delete (globalThis as Record<string, unknown>)[key];
		}
	});

	it("draws an image in the theme's ink at its natural width", async () => {
		const host = await mount(TRIANGLE);
		const img = host.querySelector("img")!;
		assert.ok(img, "the figure renders as an image");
		const svg = decodeURIComponent(img.getAttribute("src")!.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
		assert.ok(svg.includes("svg{color:rgb(1, 2, 3);"));
		assert.match(host.innerHTML, /max-width:\s*300px/);
	});

	it("has copy in its corner, but none inside a quiz option's button", async () => {
		assert.ok((await mount(TRIANGLE)).querySelector('[aria-label="Copy figure source"]'));
		await act(async () => root?.unmount());
		const host = await mount(TRIANGLE, true);
		assert.ok(host.querySelector("img"), "the figure still shows");
		assert.equal(host.querySelectorAll("button").length, 1, "no buttons nested in the option");
	});

	it("shows its source when the browser can't draw it", async () => {
		const host = await mount(TRIANGLE);
		await act(async () => {
			host.querySelector("img")!.dispatchEvent(new dom.window.Event("error"));
		});
		assert.ok(host.querySelector('[data-testid="md-svg-source"]'), "the source fallback replaces the image");
		assert.ok(!host.querySelector("img"));
	});

	it("shows the source of something that isn't an svg", async () => {
		const host = await mount("<div>not a figure</div>");
		assert.ok(host.querySelector('[data-testid="md-svg-source"]'));
	});
});

describe("drawing rules", () => {
	it("the tutor draws figures as svg, inside question text too, and never ASCII art", () => {
		const formatting = fs.readFileSync("src/agent/prompts/shared/40-formatting.md", "utf-8");
		assert.match(formatting, /write an ```svg fenced block\. It renders as a real picture, both in messages and inside question text/);
		assert.match(formatting, /Do not draw ASCII-art diagrams/);
		const demos = fs.readFileSync("src/agent/prompts/teacher/50-demos.md", "utf-8");
		assert.match(demos, /any figure inside a question, can be an inline ```svg block/);
	});
});
