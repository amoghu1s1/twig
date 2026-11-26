"use client";

import type { ImageContent } from "@earendil-works/pi-ai";
import {
	isBlank,
	PAD_BACKGROUND,
	penWidth,
	shapeGeometry,
	visibleItems,
	type PadItem,
	type Point,
} from "./model";
import { drawItem } from "./render";
import { loadDrawing } from "./state";

const PAD = 24;
const MAX_SIDE = 1600;

function itemBounds(items: readonly PadItem[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	const expand = (p: Point, radius: number) => {
		if (p.x - radius < minX) minX = p.x - radius;
		if (p.y - radius < minY) minY = p.y - radius;
		if (p.x + radius > maxX) maxX = p.x + radius;
		if (p.y + radius > maxY) maxY = p.y + radius;
	};
	for (const item of items) {
		if (item.kind === "stroke") {
			for (const pt of item.points) expand(pt, penWidth(item.size, pt.p) / 2);
		} else if (item.kind === "shape") {
			const r = item.size / 2 + 4;
			const g = shapeGeometry(item.shape, item.from, item.to, item.size);
			if (g.type === "ellipse") {
				expand({ x: g.cx - g.rx, y: g.cy - g.ry }, r);
				expand({ x: g.cx + g.rx, y: g.cy + g.ry }, r);
			} else if (g.type === "polygon") {
				for (const pt of g.points) expand(pt, r);
			} else {
				for (const line of g.lines) for (const pt of line) expand(pt, r);
			}
		}
	}
	return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Render the session's current scratchpad drawing to a trimmed PNG `ImageContent`
 * (returns null when blank or canvas is unavailable). Draws strokes/erasers on a
 * transparent layer first so `destination-out` erasers never punch through the background.
 */
export async function snapshotScratchpadPng(drawingKey: string): Promise<ImageContent | null> {
	if (typeof document === "undefined") return null;
	const items = visibleItems(loadDrawing(drawingKey));
	if (isBlank(items)) return null;
	const bounds = itemBounds(items);
	if (!bounds) return null;

	const rawW = Math.max(64, Math.ceil(bounds.maxX - bounds.minX + PAD * 2));
	const rawH = Math.max(64, Math.ceil(bounds.maxY - bounds.minY + PAD * 2));
	const scale = Math.min(1, MAX_SIDE / Math.max(rawW, rawH));
	const width = Math.max(1, Math.round(rawW * scale));
	const height = Math.max(1, Math.round(rawH * scale));

	const inkCanvas = document.createElement("canvas");
	inkCanvas.width = width;
	inkCanvas.height = height;
	const inkCtx = inkCanvas.getContext("2d");
	if (!inkCtx) return null;
	inkCtx.setTransform(scale, 0, 0, scale, (PAD - bounds.minX) * scale, (PAD - bounds.minY) * scale);
	for (const item of items) drawItem(inkCtx, item);

	const outCanvas = document.createElement("canvas");
	outCanvas.width = width;
	outCanvas.height = height;
	const outCtx = outCanvas.getContext("2d");
	if (!outCtx) return null;
	outCtx.fillStyle = PAD_BACKGROUND;
	outCtx.fillRect(0, 0, width, height);
	outCtx.drawImage(inkCanvas, 0, 0);

	const dataUrl = outCanvas.toDataURL("image/png");
	const comma = dataUrl.indexOf(",");
	if (comma < 0) return null;
	return {
		type: "image",
		mimeType: "image/png",
		data: dataUrl.slice(comma + 1),
	};
}
