/**
 * THE SCRATCHPAD'S DRAWING MODEL (pure: no DOM, no canvas): what a drawing
 * is, how each shape tool turns a drag into geometry, the undo history, and
 * how a drawing is stored. The panel (scratchpad-panel.tsx) draws it with
 * render.ts and keeps it per lesson with state.ts.
 *
 * A drawing is a list of items in drawing coordinates (CSS px from the
 * canvas's top-left; resizing the window shows more of the plane, it never
 * rescales what's drawn). Pen and eraser strokes are point lists; shapes
 * store their final geometry (any Shift constraint already applied). Clear
 * is an item too, so it undoes like everything else.
 */

/** The drawing area's background, in every theme. */
export const PAD_BACKGROUND = "#202020";

/** The pastel swatch, in order. */
export const PAD_COLORS = [
	"#ec8080",
	"#f4b084",
	"#fae080",
	"#d6f080",
	"#96e896",
	"#80e8c8",
	"#7fdcef",
	"#80b0f4",
	"#a68ef0",
	"#e690e6",
] as const;

export const DEFAULT_COLOR = "#80b0f4";

/** Pen widths, px. The eraser is wider: ERASER_SCALE × the pen width. */
export const PAD_SIZES = { thin: 2, medium: 4, thick: 8 } as const;
export type PadSizeName = keyof typeof PAD_SIZES;
export const ERASER_SCALE = 4;

export const SHAPE_KINDS = ["ellipse", "rect", "triangle", "rightTriangle", "line", "arrow"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export type PadTool = "pen" | "eraser" | ShapeKind;

export interface Point {
	x: number;
	y: number;
}

/** A pen sample: pressure (0-1) only from a pen; absent = full width. */
export interface PenPoint extends Point {
	p?: number;
}

export type PadItem =
	| { kind: "stroke"; color: string; size: number; points: PenPoint[] }
	| { kind: "erase"; size: number; points: Point[] }
	| { kind: "shape"; shape: ShapeKind; color: string; size: number; from: Point; to: Point }
	| { kind: "clear" };

// ─── shapes ──────────────────────────────────────────────────────────────────

/** A drag turned into the shape's defining corners. Shift keeps it regular:
 *  a circle, a square, an equilateral triangle, a 45° right triangle, or a
 *  line snapped to 15° steps. Pure. */
export function constrainShape(shape: ShapeKind, from: Point, to: Point, regular: boolean): { from: Point; to: Point } {
	if (!regular) return { from, to };
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	if (shape === "line" || shape === "arrow") {
		const length = Math.hypot(dx, dy);
		const step = Math.PI / 12;
		const angle = Math.round(Math.atan2(dy, dx) / step) * step;
		return { from, to: { x: from.x + length * Math.cos(angle), y: from.y + length * Math.sin(angle) } };
	}
	if (shape === "triangle") {
		// Equilateral: the drag's width sets the side, its direction the way up.
		const side = Math.abs(dx);
		const height = (side * Math.sqrt(3)) / 2;
		return { from, to: { x: to.x, y: from.y + Math.sign(dy || 1) * height } };
	}
	// Circle, square, 45° right triangle: the box's longer side both ways.
	const side = Math.max(Math.abs(dx), Math.abs(dy));
	return { from, to: { x: from.x + Math.sign(dx || 1) * side, y: from.y + Math.sign(dy || 1) * side } };
}

/** Where a pen stroke started with Shift ends: one straight line from where
 *  it started, in the 45° direction nearest the cursor, as far along it as
 *  the cursor is (the cursor projected onto it, as Photoshop does). Pure. */
export function straightPenEnd(from: Point, to: Point): Point {
	const step = Math.PI / 4;
	const angle = Math.round(Math.atan2(to.y - from.y, to.x - from.x) / step) * step;
	// Exact axes: cos(90°) is 6e-17, not 0.
	const ux = Math.round(Math.cos(angle) * 1e12) / 1e12;
	const uy = Math.round(Math.sin(angle) * 1e12) / 1e12;
	const along = Math.max(0, (to.x - from.x) * ux + (to.y - from.y) * uy);
	return { x: from.x + along * ux, y: from.y + along * uy };
}

/** What to stroke for a shape: an ellipse, a closed polygon, or open
 *  polylines (a line; an arrow's shaft and head). Screen y points down, so
 *  "top" is the smaller y. Pure. */
export type ShapeGeometry =
	| { type: "ellipse"; cx: number; cy: number; rx: number; ry: number }
	| { type: "polygon"; points: Point[] }
	| { type: "polylines"; lines: Point[][] };

export function shapeGeometry(shape: ShapeKind, from: Point, to: Point, size: number): ShapeGeometry {
	const left = Math.min(from.x, to.x);
	const right = Math.max(from.x, to.x);
	const top = Math.min(from.y, to.y);
	const bottom = Math.max(from.y, to.y);
	switch (shape) {
		case "ellipse":
			return { type: "ellipse", cx: (left + right) / 2, cy: (top + bottom) / 2, rx: (right - left) / 2, ry: (bottom - top) / 2 };
		case "rect":
			return { type: "polygon", points: [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }] };
		case "triangle":
			return { type: "polygon", points: [{ x: (left + right) / 2, y: top }, { x: right, y: bottom }, { x: left, y: bottom }] };
		case "rightTriangle":
			// The right angle at the bottom left.
			return { type: "polygon", points: [{ x: left, y: top }, { x: right, y: bottom }, { x: left, y: bottom }] };
		case "line":
			return { type: "polylines", lines: [[from, to]] };
		case "arrow": {
			const angle = Math.atan2(to.y - from.y, to.x - from.x);
			const head = Math.max(10, size * 3);
			const spread = (28 * Math.PI) / 180;
			const wing = (a: number) => ({ x: to.x - head * Math.cos(a), y: to.y - head * Math.sin(a) });
			return { type: "polylines", lines: [[from, to], [wing(angle - spread), to, wing(angle + spread)]] };
		}
	}
}

// ─── pen ─────────────────────────────────────────────────────────────────────

/** A pen segment's width: pressure scales it (a pen tablet); no pressure
 *  (mouse, touch) draws the plain width. Pure. */
export function penWidth(size: number, pressure: number | undefined): number {
	if (pressure === undefined) return size;
	return size * (0.35 + 0.95 * Math.min(Math.max(pressure, 0), 1));
}

// ─── the drawing and its history ─────────────────────────────────────────────

/** A drawing plus what undo took off it (redo puts it back). */
export interface PadHistory {
	items: PadItem[];
	undone: PadItem[];
}

export const EMPTY_HISTORY: PadHistory = { items: [], undone: [] };

/** Add an item; a new action ends the redo trail. Pure. */
export function addItem(history: PadHistory, item: PadItem): PadHistory {
	return { items: [...history.items, item], undone: [] };
}

export function undo(history: PadHistory): PadHistory {
	const last = history.items[history.items.length - 1];
	if (!last) return history;
	return { items: history.items.slice(0, -1), undone: [...history.undone, last] };
}

export function redo(history: PadHistory): PadHistory {
	const next = history.undone[history.undone.length - 1];
	if (!next) return history;
	return { items: [...history.items, next], undone: history.undone.slice(0, -1) };
}

/** The items on screen: everything after the last clear. Pure. */
export function visibleItems(items: readonly PadItem[]): PadItem[] {
	let start = 0;
	items.forEach((item, i) => {
		if (item.kind === "clear") start = i + 1;
	});
	return items.slice(start);
}

/** True when nothing is on screen. */
export function isBlank(items: readonly PadItem[]): boolean {
	return visibleItems(items).length === 0;
}

// ─── storage ─────────────────────────────────────────────────────────────────

const round = (n: number) => Math.round(n * 10) / 10;
const roundPoint = (p: PenPoint): PenPoint => (p.p === undefined ? { x: round(p.x), y: round(p.y) } : { x: round(p.x), y: round(p.y), p: Math.round(p.p * 100) / 100 });

/** The stored form: only what's on screen (a clear and everything before
 *  it can't come back after a reload), coordinates to 0.1 px. Pure. */
export function serializeDrawing(items: readonly PadItem[]): string {
	const kept = visibleItems(items).map((item): PadItem => {
		if (item.kind === "stroke") return { ...item, points: item.points.map(roundPoint) };
		if (item.kind === "erase") return { ...item, points: item.points.map((p) => ({ x: round(p.x), y: round(p.y) })) };
		if (item.kind === "shape") return { ...item, from: roundPoint(item.from), to: roundPoint(item.to) };
		return item;
	});
	return JSON.stringify({ v: 1, items: kept });
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isPoint = (v: unknown): v is Point => typeof v === "object" && v !== null && isNum((v as Point).x) && isNum((v as Point).y);
const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
const isSize = (v: unknown): v is number => isNum(v) && v > 0 && v <= 64;

/** A stored drawing, keeping only well-formed items (anything else is
 *  dropped, never fatal). Pure. */
export function parseDrawing(text: string | null): PadItem[] {
	if (!text) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return [];
	}
	const items = (raw as { items?: unknown })?.items;
	if (!Array.isArray(items)) return [];
	const out: PadItem[] = [];
	for (const it of items as Record<string, unknown>[]) {
		if (typeof it !== "object" || it === null) continue;
		if (it.kind === "stroke" && isColor(it.color) && isSize(it.size) && Array.isArray(it.points)) {
			const points = (it.points as unknown[]).filter(isPoint).map((p) => {
				const pressure = (p as PenPoint).p;
				return isNum(pressure) ? { x: p.x, y: p.y, p: pressure } : { x: p.x, y: p.y };
			});
			if (points.length > 0) out.push({ kind: "stroke", color: it.color, size: it.size, points });
		} else if (it.kind === "erase" && isSize(it.size) && Array.isArray(it.points)) {
			const points = (it.points as unknown[]).filter(isPoint).map((p) => ({ x: p.x, y: p.y }));
			if (points.length > 0) out.push({ kind: "erase", size: it.size, points });
		} else if (
			it.kind === "shape" &&
			(SHAPE_KINDS as readonly unknown[]).includes(it.shape) &&
			isColor(it.color) &&
			isSize(it.size) &&
			isPoint(it.from) &&
			isPoint(it.to)
		) {
			out.push({ kind: "shape", shape: it.shape as ShapeKind, color: it.color, size: it.size, from: { x: it.from.x, y: it.from.y }, to: { x: it.to.x, y: it.to.y } });
		}
	}
	return out;
}

/** Where a lesson's drawing lives: its chat id from a /chat/<id> path;
 *  every other page shares the "general" drawing. Pure. */
export function drawingKeyForPath(pathname: string | null | undefined): string {
	const match = /^\/chat\/([A-Za-z0-9_-]+)/.exec(pathname ?? "");
	return match ? match[1]! : "general";
}
