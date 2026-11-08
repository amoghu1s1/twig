/**
 * Drawing scratchpad items on a 2D canvas (model.ts has the geometry). The
 * canvas itself is transparent: the panel's #202020 shows through, and the
 * eraser cuts strokes away (destination-out) rather than painting gray.
 * Pen strokes are round-capped segments, so a stroke drawn live, segment by
 * segment, looks the same when the whole drawing is redrawn.
 */
import { penWidth, shapeGeometry, visibleItems, type PadItem, type PenPoint, type Point, type ShapeKind } from "./model";

function prepare(ctx: CanvasRenderingContext2D, color: string, width: number, erase: boolean): void {
	ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = width;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
}

/** One stroke segment (or a dot, when a and b coincide). */
export function drawSegment(ctx: CanvasRenderingContext2D, color: string, width: number, a: Point, b: Point, erase = false): void {
	prepare(ctx, color, width, erase);
	if (a.x === b.x && a.y === b.y) {
		ctx.beginPath();
		ctx.arc(a.x, a.y, width / 2, 0, Math.PI * 2);
		ctx.fill();
		return;
	}
	ctx.beginPath();
	ctx.moveTo(a.x, a.y);
	ctx.lineTo(b.x, b.y);
	ctx.stroke();
}

/** A pen segment at the pressure of its end point. */
export function drawPenSegment(ctx: CanvasRenderingContext2D, color: string, size: number, a: PenPoint, b: PenPoint): void {
	drawSegment(ctx, color, penWidth(size, b.p ?? a.p), a, b);
}

function drawPoints(ctx: CanvasRenderingContext2D, points: readonly PenPoint[], draw: (a: PenPoint, b: PenPoint) => void): void {
	if (points.length === 1) draw(points[0]!, points[0]!);
	for (let i = 1; i < points.length; i++) draw(points[i - 1]!, points[i]!);
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: ShapeKind, color: string, size: number, from: Point, to: Point): void {
	prepare(ctx, color, size, false);
	const g = shapeGeometry(shape, from, to, size);
	ctx.beginPath();
	if (g.type === "ellipse") {
		ctx.ellipse(g.cx, g.cy, Math.max(g.rx, 0.5), Math.max(g.ry, 0.5), 0, 0, Math.PI * 2);
	} else if (g.type === "polygon") {
		g.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
		ctx.closePath();
	} else {
		for (const line of g.lines) line.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
	}
	ctx.stroke();
}

export function drawItem(ctx: CanvasRenderingContext2D, item: PadItem): void {
	if (item.kind === "stroke") drawPoints(ctx, item.points, (a, b) => drawPenSegment(ctx, item.color, item.size, a, b));
	else if (item.kind === "erase") drawPoints(ctx, item.points, (a, b) => drawSegment(ctx, "#000", item.size, a, b, true));
	else if (item.kind === "shape") drawShape(ctx, item.shape, item.color, item.size, item.from, item.to);
}

/** Clear the canvas (device pixels) and draw what's on screen. */
export function redraw(ctx: CanvasRenderingContext2D, items: readonly PadItem[], scale: number): void {
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalCompositeOperation = "source-over";
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	ctx.setTransform(scale, 0, 0, scale, 0, 0);
	for (const item of visibleItems(items)) drawItem(ctx, item);
	ctx.globalCompositeOperation = "source-over";
}
