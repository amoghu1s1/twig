/**
 * What the scratchpad remembers, per browser (localStorage): whether it's
 * open, its width as a share of the window, and one drawing per lesson
 * (model.ts drawingKeyForPath). A convenience, not data: anything unreadable
 * falls back to defaults. Saving a drawing reports failure (a full storage)
 * so the panel can say it wasn't saved.
 *
 * Also the sidebar's sizing rules (pure, for tests): how wide it is for a
 * remembered share, and when the window is too narrow to fit it beside the
 * page.
 */
import { parseDrawing, serializeDrawing, type PadItem } from "./model";

export interface ScratchpadState {
	open: boolean;
	/** The sidebar's width as a share of the window (0 to 1). */
	fraction: number;
}

/** Half the window. */
export const DEFAULT_FRACTION = 0.5;
/** The narrowest the scratchpad gets. */
export const SIDEBAR_MIN = 320;
/** The narrowest the page beside it gets. */
export const PAGE_MIN = 420;
const STATE_KEY = "lh:scratchpad";
const DRAWING_PREFIX = "lh:scratchpad:drawing:";

/** Stored state, keeping only well-formed fields. Pure, for tests. */
export function parseScratchpadState(raw: unknown): ScratchpadState {
	const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
	const f = r.fraction;
	return {
		open: r.open === true,
		fraction: typeof f === "number" && Number.isFinite(f) && f > 0 && f < 1 ? f : DEFAULT_FRACTION,
	};
}

export function loadScratchpadState(): ScratchpadState {
	try {
		const text = window.localStorage.getItem(STATE_KEY);
		return parseScratchpadState(text ? JSON.parse(text) : null);
	} catch {
		return parseScratchpadState(null);
	}
}

export function saveScratchpadState(patch: Partial<ScratchpadState>): void {
	try {
		window.localStorage.setItem(STATE_KEY, JSON.stringify({ ...loadScratchpadState(), ...patch }));
	} catch {
		// private window or blocked storage: the scratchpad still works
	}
}

/** How the sidebar sits in a row `row` px wide whose page starts `left` px
 *  in (after the sessions sidebar): beside the page ("side"), its width
 *  kept between SIDEBAR_MIN and what leaves the page PAGE_MIN; or, when
 *  both can't fit, over the page ("cover"), as wide as the page. Pure, for
 *  tests. */
export function sidebarLayout(fraction: number, row: number, left: number): { mode: "side" | "cover"; width: number } {
	const room = row - left;
	if (room < SIDEBAR_MIN + PAGE_MIN) return { mode: "cover", width: Math.round(Math.min(row, Math.max(SIDEBAR_MIN, room))) };
	return { mode: "side", width: Math.round(Math.min(Math.max(fraction * row, SIDEBAR_MIN), room - PAGE_MIN)) };
}

/** The share of the row a divider dragged to `width` px gives, within the
 *  sidebar's limits. Pure, for tests. */
export function fractionForWidth(width: number, row: number, left: number): number {
	if (row <= 0) return DEFAULT_FRACTION;
	return sidebarLayout(width / row, row, left).width / row;
}

export function loadDrawing(key: string): PadItem[] {
	try {
		return parseDrawing(window.localStorage.getItem(DRAWING_PREFIX + key));
	} catch {
		return [];
	}
}

/** Save a lesson's drawing; false when the browser refused (storage full
 *  or blocked). An empty drawing removes its entry. */
export function saveDrawing(key: string, items: readonly PadItem[]): boolean {
	try {
		const text = serializeDrawing(items);
		if (JSON.parse(text).items.length === 0) window.localStorage.removeItem(DRAWING_PREFIX + key);
		else window.localStorage.setItem(DRAWING_PREFIX + key, text);
		return true;
	} catch {
		return false;
	}
}
