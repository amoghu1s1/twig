/**
 * The calculator's remembered state, per browser (localStorage): whether
 * it's open, where it sits, the angle mode, the recent history, and the last
 * numeric answer (`ans`). A convenience, not data: anything unreadable falls
 * back to defaults, and storage failures are ignored.
 */
import type { AngleMode } from "./engine";

export interface CalcHistoryEntry {
	expression: string;
	text: string;
}

export interface CalculatorState {
	open: boolean;
	/** Top-left corner in px; null = the default spot (bottom right). */
	position: { x: number; y: number } | null;
	angle: AngleMode;
	history: CalcHistoryEntry[];
	/** The last result when it's a plain number (what `ans` means after a reload). */
	ans: number | null;
}

export const HISTORY_LIMIT = 50;
const STORAGE_KEY = "lh:calculator";

export const DEFAULT_STATE: CalculatorState = { open: false, position: null, angle: "deg", history: [], ans: null };

/** Parse stored state, keeping only well-formed fields. Pure, for tests. */
export function parseCalculatorState(raw: unknown): CalculatorState {
	if (typeof raw !== "object" || raw === null) return { ...DEFAULT_STATE };
	const r = raw as Record<string, unknown>;
	const pos = r.position as { x?: unknown; y?: unknown } | null | undefined;
	const history = Array.isArray(r.history)
		? r.history
				.filter(
					(e): e is CalcHistoryEntry =>
						typeof e === "object" && e !== null && typeof (e as CalcHistoryEntry).expression === "string" && typeof (e as CalcHistoryEntry).text === "string",
				)
				.slice(-HISTORY_LIMIT)
		: [];
	return {
		open: r.open === true,
		position:
			pos && typeof pos.x === "number" && typeof pos.y === "number" && Number.isFinite(pos.x) && Number.isFinite(pos.y)
				? { x: pos.x, y: pos.y }
				: null,
		angle: r.angle === "rad" ? "rad" : "deg",
		history,
		ans: typeof r.ans === "number" && Number.isFinite(r.ans) ? r.ans : null,
	};
}

export function loadCalculatorState(): CalculatorState {
	try {
		const text = window.localStorage.getItem(STORAGE_KEY);
		return parseCalculatorState(text ? JSON.parse(text) : null);
	} catch {
		return { ...DEFAULT_STATE };
	}
}

/** Merge a change into the stored state. */
export function saveCalculatorState(patch: Partial<CalculatorState>): void {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadCalculatorState(), ...patch }));
	} catch {
		// private window or blocked storage: the calculator still works
	}
}

/** A top-left corner that keeps a box of this size inside the viewport
 *  (with a small margin). Pure, for tests. */
export function clampPosition(
	pos: { x: number; y: number },
	size: { width: number; height: number },
	viewport: { width: number; height: number },
	margin = 8,
): { x: number; y: number } {
	const maxX = Math.max(margin, viewport.width - size.width - margin);
	const maxY = Math.max(margin, viewport.height - size.height - margin);
	return { x: Math.min(Math.max(pos.x, margin), maxX), y: Math.min(Math.max(pos.y, margin), maxY) };
}
