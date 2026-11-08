/**
 * The scratchpad's drawing pad, interactively (linkedom + act, the
 * calculator's pattern): drawing with the pen and a shape, undo/redo by key,
 * clear with its confirm, per-lesson storage, a failed save, and its ✕ (Esc
 * doesn't close it). The sidebar around it: scratchpad-sidebar.test.tsx.
 * linkedom has no canvas, so getContext returns a recording stub.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const dom = parseHTML("<html><head></head><body></body></html>");
(dom.document as unknown as { oninput: null }).oninput = null;
const store = new Map<string, string>();
let failWrites = false;
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
Object.assign(dom.window, {
	innerWidth: 1280,
	innerHeight: 800,
	devicePixelRatio: 1,
	localStorage: {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			if (failWrites) throw new Error("QuotaExceededError");
			store.set(k, v);
		},
		removeItem: (k: string) => void store.delete(k),
	},
});
// What linkedom lacks: pointer capture, layout boxes, and a 2D context.
const proto = dom.window.HTMLElement.prototype as unknown as Record<string, unknown>;
proto.setPointerCapture = () => {};
proto.releasePointerCapture = () => {};
proto.hasPointerCapture = () => true;
proto.getBoundingClientRect = () => ({ left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 });
const paints: string[] = [];
function getContext(this: unknown) {
	return new Proxy({ canvas: this } as Record<string, unknown>, {
		get: (t, p) => (p in t ? t[p as string] : () => void paints.push(String(p))),
		set: (t, p, v) => ((t[p as string] = v), true),
	});
}
proto.getContext = getContext;
// linkedom's own canvas returns no context (it wants node-canvas): override it.
const canvasProto = (dom.window as unknown as { HTMLCanvasElement?: { prototype: Record<string, unknown> } }).HTMLCanvasElement?.prototype;
if (canvasProto) canvasProto.getContext = getContext;

const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ScratchpadPanel } = await import("../components/scratchpad/scratchpad-panel.tsx");
const { DEFAULT_COLOR, PAD_COLORS } = await import("../components/scratchpad/model.ts");

const KEY = "lh:scratchpad:drawing:chat_1";
const el = (testId: string) => {
	const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
	assert.ok(found, `missing ${testId}`);
	return found;
};
const stored = () => JSON.parse(store.get(KEY) ?? '{"items":[]}').items as { kind: string; shape?: string; points?: unknown[]; from?: unknown; to?: unknown; color?: string }[];

/** A native event with the given fields (linkedom has no PointerEvent). */
function fire(target: HTMLElement, type: string, fields: Record<string, unknown> = {}) {
	const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
	for (const [k, v] of Object.entries(fields)) Object.defineProperty(event, k, { value: v });
	target.dispatchEvent(event);
}
async function drag(points: [number, number][], extra: Record<string, unknown> = {}) {
	const canvas = el("scratchpad-canvas");
	const base = { pointerId: 1, pointerType: "mouse", button: 0, pressure: 0.5, shiftKey: false, ...extra };
	await act(async () => {
		const [first, ...rest] = points;
		fire(canvas, "pointerdown", { ...base, clientX: first![0], clientY: first![1] });
		for (const [x, y] of rest) fire(canvas, "pointermove", { ...base, clientX: x, clientY: y });
		const last = points[points.length - 1]!;
		fire(canvas, "pointerup", { ...base, clientX: last[0], clientY: last[1] });
	});
}
async function key(k: string, mods: Record<string, unknown> = {}) {
	await act(async () => fire(el("scratchpad"), "keydown", { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }));
}
async function click(testId: string) {
	await act(async () => fire(el(testId), "click"));
}

let root: Root | undefined;
let closed = 0;
async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<ScratchpadPanel drawingKey="chat_1" onClose={() => closed++} />));
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	store.clear();
	closed = 0;
	failWrites = false;
});

describe("ScratchpadPanel", () => {
	it("renders the tools, sizes and the pastel swatch on the gray", () => {
		const html = renderToStaticMarkup(<ScratchpadPanel drawingKey="chat_1" onClose={() => {}} />);
		for (const t of ["pen", "eraser", "ellipse", "rect", "triangle", "rightTriangle", "line", "arrow"]) assert.ok(html.includes(`scratchpad-tool-${t}`), t);
		for (const s of ["thin", "medium", "thick"]) assert.ok(html.includes(`scratchpad-size-${s}`), s);
		for (const c of PAD_COLORS) assert.ok(html.includes(`background-color:${c}`), c);
		assert.match(html, /background-color:#202020/);
		assert.match(html, new RegExp(`aria-checked="true"[^>]*data-testid="scratchpad-color-${DEFAULT_COLOR.slice(1)}"`));
	});

	it("draws a pen stroke and saves it to the lesson", async () => {
		await mount();
		await drag([[10, 10], [20, 20], [30, 25]]);
		const items = stored();
		assert.equal(items.length, 1);
		assert.equal(items[0]!.kind, "stroke");
		assert.equal(items[0]!.points!.length, 3);
		assert.equal(items[0]!.color, DEFAULT_COLOR);
		assert.ok(paints.includes("lineTo"), "the stroke was painted on the canvas");
	});

	it("undoes and redoes with Ctrl+Z and Ctrl+Shift+Z", async () => {
		await mount();
		await drag([[10, 10], [20, 20]]);
		await key("z", { ctrlKey: true });
		assert.equal(store.has(KEY), false, "an empty drawing removes its entry");
		await key("Z", { ctrlKey: true, shiftKey: true });
		assert.equal(stored().length, 1);
		await key("z", { ctrlKey: true });
		await key("y", { ctrlKey: true });
		assert.equal(stored().length, 1, "Ctrl+Y redoes too");
	});

	it("draws a shape by dragging, regular with Shift; a click alone draws nothing", async () => {
		await mount();
		await click("scratchpad-tool-rect");
		await click(`scratchpad-color-${PAD_COLORS[0].slice(1)}`);
		await drag([[100, 100], [130, 160]], { shiftKey: true });
		const [rect] = stored();
		assert.equal(rect!.shape, "rect");
		assert.equal(rect!.color, PAD_COLORS[0]);
		assert.deepEqual(rect!.to, { x: 160, y: 160 }, "Shift: a square");
		await drag([[50, 50], [50, 50]]);
		assert.equal(stored().length, 1);
	});

	it("draws the pen straight in 45° steps when Shift is held as the stroke starts", async () => {
		await mount();
		await drag([[100, 100], [140, 90], [200, 106]], { shiftKey: true });
		const [line] = stored();
		assert.equal(line!.kind, "stroke");
		assert.deepEqual(line!.points, [{ x: 100, y: 100 }, { x: 200, y: 100 }], "one flat line, wobbles dropped");
		await drag([[50, 50], [50, 50]], { shiftKey: true });
		assert.deepEqual(stored()[1]!.points, [{ x: 50, y: 50 }], "a Shift-click leaves a dot");
		await drag([[10, 10], [20, 25], [30, 25]]);
		assert.equal(stored()[2]!.points!.length, 3, "no Shift: freehand");
	});

	it("clears only after the confirm, and the clear undoes", async () => {
		await mount();
		await drag([[10, 10], [20, 20]]);
		await click("scratchpad-clear");
		assert.equal(stored().length, 1, "not yet");
		await key("Escape");
		assert.equal(closed, 0, "Esc first backs out of the confirm");
		await click("scratchpad-clear");
		await click("scratchpad-clear-yes");
		assert.equal(store.has(KEY), false);
		await click("scratchpad-undo");
		assert.equal(stored().length, 1);
	});

	it("opens with the lesson's saved drawing", async () => {
		store.set(KEY, JSON.stringify({ v: 1, items: [{ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: 1, y: 1 }] }] }));
		await mount();
		assert.equal(el("scratchpad-clear").hasAttribute("disabled"), false);
		assert.equal(el("scratchpad-undo").hasAttribute("disabled"), false);
	});

	it("says so when the browser won't save", async () => {
		await mount();
		failWrites = true;
		await drag([[10, 10], [20, 20]]);
		assert.match(el("scratchpad-unsaved").textContent ?? "", /Not saved/);
	});

	it("closes with its ✕, never on Esc", async () => {
		await mount();
		await key("Escape");
		assert.equal(closed, 0);
		await click("scratchpad-close");
		assert.equal(closed, 1);
	});
});
