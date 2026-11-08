/**
 * The scratchpad sidebar, interactively (linkedom + act): opening on its
 * toggle beside the page at half the window, remembering it, focusing only
 * when the user opens it, the divider (drag within the limits, double-click
 * back to half), covering the page in a narrow window, and its ✕.
 * linkedom has no layout, so boxes come from a stub keyed by element.
 */
import React, { act, useRef } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const dom = parseHTML("<html><head></head><body></body></html>");
(dom.document as unknown as { oninput: null }).oninput = null;
const store = new Map<string, string>();
const observers = new Set<() => void>();
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	ResizeObserver: class {
		private cb: () => void;
		constructor(cb: () => void) {
			this.cb = cb;
		}
		observe() {
			observers.add(this.cb);
		}
		disconnect() {
			observers.delete(this.cb);
		}
	},
});
Object.assign(dom.window, {
	innerWidth: 1600,
	innerHeight: 900,
	devicePixelRatio: 1,
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	},
});

// Layout: a row `rowWidth` wide whose page starts `pageLeft` in.
let rowWidth = 1600;
let pageLeft = 0;
let focused: unknown = null;
const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
proto.setPointerCapture = () => {};
proto.releasePointerCapture = () => {};
proto.hasPointerCapture = () => true;
proto.focus = function (this: unknown) {
	focused = this;
};
proto.getBoundingClientRect = function (this: HTMLElement) {
	if (this.dataset?.testid === "row") return { left: 0, top: 0, right: rowWidth, bottom: 900, width: rowWidth, height: 900 };
	if (this.tagName === "MAIN") return { left: pageLeft, top: 0, right: rowWidth, bottom: 900, width: rowWidth - pageLeft, height: 900 };
	return { left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 };
};
function getContext(this: unknown) {
	return new Proxy({ canvas: this } as Record<string, unknown>, {
		get: (t, p) => (p in t ? t[p as string] : () => {}),
		set: (t, p, v) => ((t[p as string] = v), true),
	});
}
proto.getContext = getContext;
const canvasProto = (dom.window as unknown as { HTMLCanvasElement?: { prototype: Record<string, unknown> } }).HTMLCanvasElement?.prototype;
if (canvasProto) canvasProto.getContext = getContext;

const { createRoot } = await import("react-dom/client");
const { ScratchpadHost, SCRATCHPAD_TOGGLE_EVENT } = await import("../components/scratchpad/scratchpad-host.tsx");
const { PAGE_MIN, SIDEBAR_MIN } = await import("../components/scratchpad/state.ts");

const KEY = "lh:scratchpad";
const query = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const el = (testId: string) => {
	const found = query(testId);
	assert.ok(found, `missing ${testId}`);
	return found;
};
const saved = () => JSON.parse(store.get(KEY) ?? "{}") as { open?: boolean; fraction?: number };
const width = () => el("scratchpad-sidebar").style.width;

function fire(target: HTMLElement, type: string, fields: Record<string, unknown> = {}) {
	const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
	for (const [k, v] of Object.entries(fields)) Object.defineProperty(event, k, { value: v });
	target.dispatchEvent(event);
}
/** Let the lazy panel load. */
const settle = () => act(async () => new Promise((r) => setTimeout(r, 20)));
async function toggle() {
	await act(async () => void window.dispatchEvent(new dom.window.Event(SCRATCHPAD_TOGGLE_EVENT)));
	await settle();
}
async function dragDivider(toX: number) {
	const divider = el("scratchpad-divider");
	const base = { pointerId: 1, pointerType: "mouse", button: 0 };
	await act(async () => {
		fire(divider, "pointerdown", { ...base, clientX: rowWidth / 2 });
		fire(divider, "pointermove", { ...base, clientX: toX });
		fire(divider, "pointerup", { ...base, clientX: toX });
	});
}
/** The window or the sessions sidebar changed size. */
async function relayout(row: number, left: number) {
	rowWidth = row;
	pageLeft = left;
	await act(async () => {
		for (const cb of observers) cb();
	});
}

function Shell() {
	const page = useRef<HTMLElement>(null);
	return (
		<>
			<main ref={page} />
			<ScratchpadHost page={page} />
		</>
	);
}

let root: Root | undefined;
async function mount() {
	const row = document.createElement("div");
	row.dataset.testid = "row";
	document.body.appendChild(row);
	root = createRoot(row);
	await act(async () => root!.render(<Shell />));
	await settle();
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	document.body.innerHTML = "";
	store.clear();
	observers.clear();
	rowWidth = 1600;
	pageLeft = 0;
	focused = null;
});

describe("the scratchpad sidebar", () => {
	it("opens on its toggle at half the window, beside the page, and remembers it", async () => {
		await mount();
		assert.equal(query("scratchpad-sidebar"), null, "closed by default");
		await toggle();
		assert.equal(width(), "800px");
		assert.equal(el("scratchpad-sidebar").dataset.mode, "side");
		assert.ok(query("scratchpad-divider"));
		assert.ok(query("scratchpad-canvas"), "the drawing pad loaded");
		assert.equal(saved().open, true);
		await toggle();
		assert.equal(query("scratchpad-sidebar"), null);
		assert.equal(saved().open, false);
	});

	it("takes focus when the user opens it, never when a page loads with it open", async () => {
		store.set(KEY, JSON.stringify({ open: true, fraction: 0.5 }));
		await mount();
		assert.ok(query("scratchpad"), "restored open");
		assert.equal(focused, null, "a page load leaves focus where it is");
		await toggle();
		await toggle();
		assert.equal(focused, el("scratchpad"), "opened by the user: focused");
	});

	it("drags the divider within the limits and remembers the share", async () => {
		await mount();
		await toggle();
		await dragDivider(1000);
		assert.equal(width(), "600px");
		assert.equal(saved().fraction, 600 / 1600);
		await dragDivider(1590);
		assert.equal(width(), `${SIDEBAR_MIN}px`, "never narrower than its minimum");
		await dragDivider(10);
		assert.equal(width(), `${1600 - PAGE_MIN}px`, "the page keeps its minimum");
		await act(async () => fire(el("scratchpad-divider"), "dblclick"));
		assert.equal(width(), "800px", "double-click: back to half");
		assert.equal(saved().fraction, 0.5);
	});

	it("ends a drag the browser drops without a pointerup", async () => {
		await mount();
		await toggle();
		const divider = el("scratchpad-divider");
		const base = { pointerId: 1, pointerType: "mouse", button: 0 };
		await act(async () => {
			fire(divider, "pointerdown", { ...base, clientX: 800 });
			fire(divider, "pointermove", { ...base, clientX: 1000 });
			fire(divider, "lostpointercapture", base);
		});
		assert.equal(width(), "600px");
		assert.equal(saved().fraction, 600 / 1600, "saved as it ended");
		await act(async () => fire(divider, "pointermove", { ...base, clientX: 700 }));
		assert.equal(width(), "600px", "a later hover doesn't resize");
	});

	it("makes room for the sessions sidebar, and covers the page in a narrow window", async () => {
		store.set(KEY, JSON.stringify({ open: true, fraction: 0.6 }));
		await mount();
		assert.equal(width(), "960px");
		await relayout(1600, 288);
		assert.equal(width(), `${1600 - 288 - PAGE_MIN}px`, "the page keeps its minimum beside both sidebars");
		await relayout(900, 288);
		assert.equal(el("scratchpad-sidebar").dataset.mode, "cover");
		assert.equal(width(), "612px", "over the page, as wide as it");
		assert.equal(query("scratchpad-divider"), null, "nothing to drag");
		await relayout(1600, 0);
		assert.equal(width(), "960px", "a wider window: beside the page again, at its share");
	});

	it("closes with its ✕, and Esc leaves it open", async () => {
		await mount();
		await toggle();
		await act(async () => fire(el("scratchpad"), "keydown", { key: "Escape", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }));
		assert.ok(query("scratchpad-sidebar"), "Esc doesn't close it");
		await act(async () => fire(el("scratchpad-close"), "click"));
		assert.equal(query("scratchpad-sidebar"), null);
		assert.equal(saved().open, false);
	});
});
