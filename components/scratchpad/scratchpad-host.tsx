"use client";
/**
 * The scratchpad sidebar: a full-height column at the right edge of the
 * window (AppShell, after the page), mirroring the sessions sidebar on the
 * left. The page shrinks to fit beside it. It opens and closes on the
 * toggle-scratchpad shortcut (Alt+P by default), its button, or its ✕;
 * remembers whether it was open and its width; and loads the drawing pad
 * only when first opened. The drawing shown is the current lesson's (from
 * the URL); switching lessons switches drawings.
 *
 * Width: half the window by default, as a share of it, so it scales with
 * the window. The divider on its left edge drags it wider or narrower
 * (double-click: back to half), keeping the scratchpad at least SIDEBAR_MIN
 * and the page at least PAGE_MIN. A window too narrow for both gets the
 * scratchpad over the page instead (state.ts sidebarLayout).
 */
import { Component, lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { usePathname } from "next/navigation";
import { kbdEventForAction } from "@/src/core";
import { cn } from "@/lib/utils";
import { drawingKeyForPath } from "./model";
import { DEFAULT_FRACTION, fractionForWidth, loadScratchpadState, saveScratchpadState, sidebarLayout } from "./state";

const ScratchpadPanel = lazy(() => import("./scratchpad-panel").then((m) => ({ default: m.ScratchpadPanel })));

/** The window event that toggles the scratchpad (shortcut and button). */
export const SCRATCHPAD_TOGGLE_EVENT = kbdEventForAction("toggle-scratchpad");

/** A panel that fails to load (a stale chunk after a deploy, offline)
 *  shows a small note instead of taking the page down with it. */
class ScratchpadBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div role="alert" className="flex flex-1 flex-col items-start gap-2 bg-background p-4 text-xs text-muted-foreground">
				The scratchpad couldn&apos;t load. Reload the page to try again.
				<button type="button" onClick={this.props.onClose} className="text-foreground underline underline-offset-2">
					Close
				</button>
			</div>
		);
	}
}

/** `page` is the page's column (AppShell's <main>): where it starts tells
 *  how much of the row the sessions sidebar takes. */
export function ScratchpadHost({ page }: { page: RefObject<HTMLElement | null> }) {
	const drawingKey = drawingKeyForPath(usePathname());
	// Closed on the server; the remembered state applies after mount.
	const [open, setOpen] = useState<boolean | null>(null);
	// Set when the user opens it, taken by the panel as it mounts.
	const focusOnOpen = useRef(false);
	useLayoutEffect(() => {
		setOpen(loadScratchpadState().open);
		const toggle = () =>
			setOpen((o) => {
				focusOnOpen.current = !o;
				return !o;
			});
		window.addEventListener(SCRATCHPAD_TOGGLE_EVENT, toggle);
		return () => window.removeEventListener(SCRATCHPAD_TOGGLE_EVENT, toggle);
	}, []);
	useEffect(() => {
		if (open !== null) saveScratchpadState({ open });
	}, [open]);
	if (!open) return null;
	const close = () => setOpen(false);
	const takeFocus = () => {
		const focus = focusOnOpen.current;
		focusOnOpen.current = false;
		return focus;
	};
	return (
		<ScratchpadSidebar page={page}>
			<ScratchpadBoundary onClose={close}>
				<Suspense fallback={null}>
					{/* A new lesson remounts the panel with that lesson's drawing. */}
					<ScratchpadPanel key={drawingKey} drawingKey={drawingKey} onClose={close} takeFocus={takeFocus} />
				</Suspense>
			</ScratchpadBoundary>
		</ScratchpadSidebar>
	);
}

/** The column itself: its width, the divider, and the narrow-window cover. */
function ScratchpadSidebar({ page, children }: { page: RefObject<HTMLElement | null>; children: ReactNode }) {
	const ref = useRef<HTMLElement>(null);
	const [fraction, setFraction] = useState(() => loadScratchpadState().fraction);
	const fractionRef = useRef(fraction);
	fractionRef.current = fraction;
	// The row's width and where the page starts in it, measured before the
	// first paint and again as the window or the sessions sidebar changes.
	const [box, setBox] = useState<{ row: number; left: number } | null>(null);
	const boxRef = useRef(box);
	boxRef.current = box;
	useLayoutEffect(() => {
		const row = ref.current?.parentElement;
		const pageEl = page.current;
		if (!row || !pageEl) return;
		const measure = () => {
			const rowRect = row.getBoundingClientRect();
			const next = { row: rowRect.width, left: Math.max(0, pageEl.getBoundingClientRect().left - rowRect.left) };
			setBox((prev) => (prev && prev.row === next.row && prev.left === next.left ? prev : next));
		};
		measure();
		// The page's own width changes with the sessions sidebar (and with
		// this one, which measures the same and changes nothing).
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		observer.observe(pageEl);
		return () => observer.disconnect();
	}, [page]);

	const layout = box ? sidebarLayout(fraction, box.row, box.left) : null;
	const cover = layout?.mode === "cover";

	const drag = useRef<number | null>(null);
	const [dragging, setDragging] = useState(false);
	const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		drag.current = e.pointerId;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
		setDragging(true);
	};
	const onDividerMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const b = boxRef.current;
		const row = ref.current?.parentElement;
		if (drag.current !== e.pointerId || !b || !row) return;
		// Kept in the ref at once: the release can come before the re-render.
		fractionRef.current = fractionForWidth(row.getBoundingClientRect().right - e.clientX, b.row, b.left);
		setFraction(fractionRef.current);
	};
	const onDividerUp = (e: React.PointerEvent<HTMLDivElement>) => {
		if (drag.current !== e.pointerId) return;
		drag.current = null;
		if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
		setDragging(false);
		saveScratchpadState({ fraction: fractionRef.current });
	};
	const resetWidth = () => {
		setFraction(DEFAULT_FRACTION);
		saveScratchpadState({ fraction: DEFAULT_FRACTION });
	};

	return (
		<aside
			ref={ref}
			aria-label="Scratchpad"
			data-testid="scratchpad-sidebar"
			data-mode={layout?.mode}
			className={cn(
				"flex h-full shrink-0",
				cover ? "fixed inset-y-0 right-0 z-30 border-l border-border shadow-2xl" : "relative",
				// Hidden for the one render before it's measured.
				!layout && "invisible",
			)}
			style={{ width: layout?.width ?? 0 }}
		>
			{!cover && (
				<div
					role="separator"
					aria-orientation="vertical"
					aria-label="Resize the scratchpad"
					title="Drag to resize · double-click for half"
					data-testid="scratchpad-divider"
					onPointerDown={onDividerDown}
					onPointerMove={onDividerMove}
					onPointerUp={onDividerUp}
					onPointerCancel={onDividerUp}
					// A drag the browser drops without a pointerup (the window
					// loses focus mid-drag) ends here, not on the next hover.
					onLostPointerCapture={onDividerUp}
					onDoubleClick={resetWidth}
					className="group relative w-1.5 shrink-0 cursor-col-resize touch-none bg-background"
				>
					{/* The border line, wider and tinted while hovered or dragged. */}
					<span
						aria-hidden="true"
						className={cn(
							"absolute inset-y-0 left-0 w-px bg-border transition-[width,background-color] duration-150",
							dragging ? "w-[3px] bg-primary/60" : "group-hover:w-[3px] group-hover:bg-primary/40",
						)}
					/>
				</div>
			)}
			{children}
		</aside>
	);
}
