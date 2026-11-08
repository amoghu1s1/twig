/**
 * The floating calculator panel, interactively (linkedom + act): the live
 * result, the DEG/RAD switch, history and recall, the function buttons,
 * and Esc closing it without reaching the page.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const dom = parseHTML("<html><head></head><body></body></html>");
// React checks native "input" event support when react-dom first loads, so
// the DOM (with an oninput slot linkedom lacks) must exist before it does;
// react-dom and the panel are imported dynamically below for that reason.
(dom.document as unknown as { oninput: null }).oninput = null;
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
});
// linkedom has no text selection API; the panel only positions the caret.
(dom.window.HTMLElement.prototype as unknown as { setSelectionRange: () => void }).setSelectionRange = () => {};
Object.assign(dom.window, {
	innerWidth: 1280,
	innerHeight: 800,
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
});

const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { CALCULATOR_KEYS, CalculatorPanel } = await import("../components/calculator/calculator-panel.tsx");

const el = <T extends HTMLElement = HTMLElement>(testId: string) => {
	const found = document.querySelector<T>(`[data-testid="${testId}"]`);
	assert.ok(found, `missing ${testId}`);
	return found;
};
const textOf = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

/** Type into the input the way React notices: set the value through the
 *  prototype's setter (React's change tracker watches the element's own
 *  "value" property), then fire "input". */
async function type(value: string) {
	const input = el<HTMLInputElement>("calculator-input");
	let proto: object | null = Object.getPrototypeOf(input);
	let setter: ((v: string) => void) | undefined;
	while (proto && !setter) {
		setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		proto = Object.getPrototypeOf(proto);
	}
	await act(async () => {
		setter!.call(input, value);
		input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
	});
}
/** A keydown with a key (linkedom has no KeyboardEvent constructor). */
async function key(target: HTMLElement, k: string) {
	await act(async () => {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: k });
		target.dispatchEvent(event);
	});
}
async function click(target: HTMLElement) {
	await act(async () => {
		target.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
	});
}

let root: Root | undefined;
let closed = 0;
async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<CalculatorPanel onClose={() => closed++} />));
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	store.clear();
	closed = 0;
});

describe("CalculatorPanel", () => {
	it("renders the title, the angle switch and the function buttons", () => {
		const html = renderToStaticMarkup(<CalculatorPanel onClose={() => {}} />);
		assert.match(html, /Calculator/);
		assert.match(html, /aria-checked="true" data-testid="calculator-deg"/);
		for (const k of CALCULATOR_KEYS) assert.ok(html.includes(`>${k.label}<`), k.label);
	});

	it("shows results live, follows DEG/RAD, saves history, recalls with ↑", async () => {
		await mount();
		await type("sin(30)");
		assert.equal(textOf("calculator-result"), "= 0.5");
		await click(el("calculator-rad"));
		assert.equal(textOf("calculator-result"), "= -0.9880316241");
		await click(el("calculator-deg"));
		await key(el("calculator-input"), "Enter");
		assert.match(textOf("calculator-history") ?? "", /sin\(30\)\s*= 0\.5/);
		assert.equal(el<HTMLInputElement>("calculator-input").value, "");
		await type("ans * 4");
		assert.equal(textOf("calculator-result"), "= 2");
		await key(el("calculator-input"), "ArrowUp");
		assert.equal(el<HTMLInputElement>("calculator-input").value, "sin(30)");
		// Back down: the half-typed line comes back.
		await key(el("calculator-input"), "ArrowDown");
		assert.equal(el<HTMLInputElement>("calculator-input").value, "ans * 4");
		// Remembered: history, the last answer, and the angle mode.
		const saved = JSON.parse(store.get("lh:calculator") ?? "{}");
		assert.deepEqual(saved.history, [{ expression: "sin(30)", text: "0.5" }]);
		assert.equal(saved.ans, 0.5);
		assert.equal(saved.angle, "deg");
	});

	it("shows an error only after Enter on a bad line", async () => {
		await mount();
		await type("sin(");
		assert.equal(textOf("calculator-error"), null);
		await key(el("calculator-input"), "Enter");
		assert.match(textOf("calculator-error") ?? "", /end of expression/);
	});

	it("inserts a function at the cursor from its button", async () => {
		await mount();
		const tan = [...document.querySelectorAll("button")].find((b) => b.textContent === "tan")!;
		await click(tan);
		assert.equal(el<HTMLInputElement>("calculator-input").value, "tan(");
	});

	it("keeps Tab inside the calculator (the page's Tab would pull focus away)", async () => {
		await mount();
		let reached = false;
		const onWindow = () => (reached = true);
		dom.window.addEventListener("keydown", onWindow);
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.defineProperty(event, "key", { value: "Tab" });
		await act(async () => {
			el("calculator-input").dispatchEvent(event);
		});
		dom.window.removeEventListener("keydown", onWindow);
		assert.equal(event.defaultPrevented, true);
		assert.equal(reached, false);
		assert.equal(closed, 0);
	});

	it("closes on Esc without letting the page see it", async () => {
		await mount();
		let reached = false;
		const onWindow = () => (reached = true);
		dom.window.addEventListener("keydown", onWindow);
		await key(el("calculator-input"), "Escape");
		dom.window.removeEventListener("keydown", onWindow);
		assert.equal(closed, 1);
		assert.equal(reached, false);
	});
});
