/**
 * The scratchpad's pure parts: shape constraints and geometry, pen width,
 * the undo history (clear included), storage round-trips, the per-lesson
 * key, the sidebar's state and sizing, and what the renderer asks the canvas
 * to do.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	addItem,
	constrainShape,
	drawingKeyForPath,
	EMPTY_HISTORY,
	isBlank,
	PAD_BACKGROUND,
	PAD_COLORS,
	parseDrawing,
	penWidth,
	redo,
	serializeDrawing,
	shapeGeometry,
	straightPenEnd,
	undo,
	visibleItems,
	type PadItem,
} from "../components/scratchpad/model.ts";
import { fractionForWidth, PAGE_MIN, parseScratchpadState, SIDEBAR_MIN, sidebarLayout } from "../components/scratchpad/state.ts";
import { drawItem } from "../components/scratchpad/render.ts";
import { KEYBOARD_ACTIONS } from "../src/core/keyboard.ts";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

describe("the swatch and background", () => {
	it("are the user's pastel set and gray", () => {
		assert.equal(PAD_BACKGROUND, "#202020");
		assert.deepEqual([...PAD_COLORS], ["#ec8080", "#f4b084", "#fae080", "#d6f080", "#96e896", "#80e8c8", "#7fdcef", "#80b0f4", "#a68ef0", "#e690e6"]);
	});
});

describe("shapes", () => {
	const from = { x: 100, y: 100 };

	it("Shift makes circles and squares regular, in the drag's direction", () => {
		assert.deepEqual(constrainShape("ellipse", from, { x: 130, y: 160 }, true), { from, to: { x: 160, y: 160 } });
		assert.deepEqual(constrainShape("rect", from, { x: 40, y: 120 }, true), { from, to: { x: 40, y: 160 } });
		assert.deepEqual(constrainShape("rect", from, { x: 130, y: 160 }, false), { from, to: { x: 130, y: 160 } }, "no Shift: as dragged");
	});

	it("Shift makes the triangle equilateral and the right triangle 45°", () => {
		const eq = constrainShape("triangle", from, { x: 200, y: 150 }, true);
		assert.ok(close(eq.to.y - from.y, (100 * Math.sqrt(3)) / 2));
		const right = constrainShape("rightTriangle", from, { x: 160, y: 130 }, true);
		assert.deepEqual(right.to, { x: 160, y: 160 });
	});

	it("Shift snaps lines and arrows to 15° steps, keeping the length", () => {
		const { to } = constrainShape("line", from, { x: 200, y: 108 }, true);
		assert.ok(close(to.y, 100), "a near-flat line snaps flat");
		assert.ok(close(Math.hypot(to.x - 100, to.y - 100), Math.hypot(100, 8)));
	});

	it("puts the right angle at the bottom left whichever way you drag", () => {
		for (const to of [{ x: 200, y: 200 }, { x: 0, y: 0 }]) {
			const g = shapeGeometry("rightTriangle", from, to, 4);
			assert.equal(g.type, "polygon");
			const pts = (g as { points: { x: number; y: number }[] }).points;
			const left = Math.min(from.x, to.x);
			const bottom = Math.max(from.y, to.y);
			assert.ok(pts.some((p) => p.x === left && p.y === bottom), "a corner at the box's bottom left");
		}
	});

	it("draws an arrow as a shaft plus a two-sided head", () => {
		const g = shapeGeometry("arrow", from, { x: 200, y: 100 }, 4);
		assert.equal(g.type, "polylines");
		const lines = (g as { lines: { x: number; y: number }[][] }).lines;
		assert.equal(lines.length, 2);
		assert.equal(lines[1]!.length, 3);
		assert.ok(lines[1]!.every((p) => p.x <= 200), "the head points back from the tip");
	});

	it("an ellipse spans the drag box", () => {
		assert.deepEqual(shapeGeometry("ellipse", from, { x: 160, y: 140 }, 2), { type: "ellipse", cx: 130, cy: 120, rx: 30, ry: 20 });
	});
});

describe("the pen", () => {
	it("with Shift, draws straight in 45° steps, ending where the cursor is along the line", () => {
		const from = { x: 100, y: 100 };
		assert.deepEqual(straightPenEnd(from, { x: 200, y: 108 }), { x: 200, y: 100 }, "near-flat: flat, to the cursor's x");
		assert.deepEqual(straightPenEnd(from, { x: 94, y: 20 }), { x: 100, y: 20 }, "near-vertical: straight up");
		const diag = straightPenEnd(from, { x: 150, y: 160 });
		assert.ok(close(diag.x - 100, diag.y - 100), "a diagonal: 45° exactly");
		assert.ok(close(diag.x - 100, 55), "as far as the cursor is along it");
		assert.deepEqual(straightPenEnd(from, { x: 40, y: 103 }), { x: 40, y: 100 }, "leftward too");
		assert.deepEqual(straightPenEnd(from, from), from);
	});

	it("draws the plain width without pressure, and scales with a pen's pressure", () => {
		assert.equal(penWidth(4, undefined), 4);
		assert.ok(penWidth(4, 0.1) < penWidth(4, 0.9));
		assert.ok(penWidth(4, 5) <= 4 * 1.3, "pressure is clamped");
	});
});

describe("the history", () => {
	const stroke = (n: number): PadItem => ({ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: n, y: n }] });

	it("undoes and redoes, and a new action ends the redo trail", () => {
		let h = addItem(addItem(EMPTY_HISTORY, stroke(1)), stroke(2));
		h = undo(h);
		assert.equal(h.items.length, 1);
		assert.equal(h.undone.length, 1);
		h = redo(h);
		assert.equal(h.items.length, 2);
		h = addItem(undo(h), stroke(3));
		assert.deepEqual(h.undone, []);
		assert.equal(undo(EMPTY_HISTORY), EMPTY_HISTORY, "nothing to undo: unchanged");
	});

	it("clear hides everything before it, and undoing it brings it back", () => {
		let h = addItem(addItem(EMPTY_HISTORY, stroke(1)), { kind: "clear" });
		assert.ok(isBlank(h.items));
		h = addItem(h, stroke(2));
		assert.equal(visibleItems(h.items).length, 1);
		h = undo(undo(h));
		assert.equal(visibleItems(h.items).length, 1);
		assert.ok(!isBlank(h.items));
	});
});

describe("storage", () => {
	it("round-trips a drawing at 0.1 px, keeping only what's on screen", () => {
		const items: PadItem[] = [
			{ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: 1.234, y: 5.678 }] },
			{ kind: "clear" },
			{ kind: "stroke", color: "#80b0f4", size: 4, points: [{ x: 10.04, y: 20.06, p: 0.456 }] },
			{ kind: "erase", size: 16, points: [{ x: 3, y: 4 }] },
			{ kind: "shape", shape: "arrow", color: "#96e896", size: 8, from: { x: 0, y: 0 }, to: { x: 9.99, y: 1 } },
		];
		assert.deepEqual(parseDrawing(serializeDrawing(items)), [
			{ kind: "stroke", color: "#80b0f4", size: 4, points: [{ x: 10, y: 20.1, p: 0.46 }] },
			{ kind: "erase", size: 16, points: [{ x: 3, y: 4 }] },
			{ kind: "shape", shape: "arrow", color: "#96e896", size: 8, from: { x: 0, y: 0 }, to: { x: 10, y: 1 } },
		]);
	});

	it("drops anything malformed and never throws", () => {
		assert.deepEqual(parseDrawing(null), []);
		assert.deepEqual(parseDrawing("not json"), []);
		const text = JSON.stringify({
			v: 1,
			items: [
				{ kind: "stroke", color: "red", size: 2, points: [{ x: 1, y: 1 }] },
				{ kind: "stroke", color: "#ec8080", size: 999, points: [{ x: 1, y: 1 }] },
				{ kind: "shape", shape: "star", color: "#ec8080", size: 2, from: { x: 0, y: 0 }, to: { x: 1, y: 1 } },
				{ kind: "erase", size: 8, points: [{ x: "a" }] },
				{ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: 1, y: 1 }] },
			],
		});
		assert.deepEqual(parseDrawing(text), [{ kind: "stroke", color: "#ec8080", size: 2, points: [{ x: 1, y: 1 }] }]);
	});

	it("keys drawings by lesson, everything else shares one", () => {
		assert.equal(drawingKeyForPath("/chat/chat_mvo2s58j_e47d075a"), "chat_mvo2s58j_e47d075a");
		assert.equal(drawingKeyForPath("/chat/chat_1?x=1"), "chat_1");
		assert.equal(drawingKeyForPath("/graph"), "general");
		assert.equal(drawingKeyForPath(null), "general");
	});
});

describe("the sidebar", () => {
	it("reads stored state defensively: closed at half the window by default", () => {
		assert.deepEqual(parseScratchpadState(null), { open: false, fraction: 0.5 });
		assert.deepEqual(parseScratchpadState({ open: true, fraction: 0.3 }), { open: true, fraction: 0.3 });
		for (const fraction of [0, 1, 1.5, -0.2, Number.NaN, "0.3"]) assert.equal(parseScratchpadState({ fraction }).fraction, 0.5, String(fraction));
		// The floating window's old state: still opens, at half.
		assert.deepEqual(parseScratchpadState({ open: true, position: { x: 5, y: 6 }, size: { width: 560, height: 440 } }), { open: true, fraction: 0.5 });
	});

	it("takes its share of the window, beside the page", () => {
		assert.deepEqual(sidebarLayout(0.5, 1600, 0), { mode: "side", width: 800 });
		assert.deepEqual(sidebarLayout(0.5, 1600, 288), { mode: "side", width: 800 }, "the share is of the whole window");
		assert.deepEqual(sidebarLayout(0.3, 1000, 0), { mode: "side", width: 320 }, "never narrower than its minimum");
	});

	it("always leaves the page its minimum", () => {
		assert.deepEqual(sidebarLayout(0.9, 1600, 0), { mode: "side", width: 1600 - PAGE_MIN });
		assert.deepEqual(sidebarLayout(0.5, 1200, 288), { mode: "side", width: 1200 - 288 - PAGE_MIN }, "with the sessions sidebar open");
		assert.deepEqual(sidebarLayout(0.5, SIDEBAR_MIN + PAGE_MIN, 0), { mode: "side", width: SIDEBAR_MIN }, "just fits");
	});

	it("covers the page when both can't fit", () => {
		assert.deepEqual(sidebarLayout(0.5, 700, 0), { mode: "cover", width: 700 });
		assert.deepEqual(sidebarLayout(0.5, 900, 288), { mode: "cover", width: 612 }, "as wide as the page");
		assert.deepEqual(sidebarLayout(0.5, 500, 288), { mode: "cover", width: SIDEBAR_MIN }, "but never under its minimum");
		assert.deepEqual(sidebarLayout(0.5, 300, 0), { mode: "cover", width: 300 }, "nor wider than the window");
	});

	it("turns a dragged divider into a share, within the limits", () => {
		assert.equal(fractionForWidth(600, 1600, 0), 600 / 1600);
		assert.equal(fractionForWidth(100, 1600, 0), SIDEBAR_MIN / 1600);
		assert.equal(fractionForWidth(1500, 1600, 288), (1600 - 288 - PAGE_MIN) / 1600);
		assert.equal(fractionForWidth(500, 0, 0), 0.5, "an unmeasured row: the default");
	});

	it("opens with Alt+P", () => {
		assert.equal(KEYBOARD_ACTIONS.find((a) => a.id === "toggle-scratchpad")?.binding, "alt+p");
	});
});

describe("rendering", () => {
	function fakeCtx() {
		const calls: string[] = [];
		const ctx = new Proxy(
			{ calls, globalCompositeOperation: "source-over" } as Record<string, unknown>,
			{
				get(target, prop) {
					if (prop in target) return target[prop as string];
					return (...args: unknown[]) => void calls.push(`${String(prop)}(${args.length})`);
				},
				set(target, prop, value) {
					target[prop as string] = value;
					if (prop === "globalCompositeOperation") calls.push(`gco=${value}`);
					return true;
				},
			},
		);
		return ctx as unknown as CanvasRenderingContext2D & { calls: string[] };
	}

	it("erases with destination-out and strokes shapes with their geometry", () => {
		const ctx = fakeCtx();
		drawItem(ctx, { kind: "erase", size: 16, points: [{ x: 0, y: 0 }, { x: 5, y: 5 }] });
		assert.ok(ctx.calls.includes("gco=destination-out"));
		const shapes = fakeCtx();
		drawItem(shapes, { kind: "shape", shape: "ellipse", color: "#ec8080", size: 2, from: { x: 0, y: 0 }, to: { x: 10, y: 10 } });
		assert.ok(shapes.calls.includes("ellipse(7)"));
		assert.ok(shapes.calls.includes("stroke(0)"));
	});
});
