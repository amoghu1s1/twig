"use client";
/**
 * Mounts the floating calculator (root layout, every page). It opens and
 * closes on the toggle-calculator shortcut (Alt+C by default) or the
 * calculator button, remembers whether it was open, and loads the panel
 * (and mathjs with it) only when first opened.
 */
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { kbdEventForAction } from "@/src/core";
import { loadCalculatorState, saveCalculatorState } from "./state";

const CalculatorPanel = lazy(() => import("./calculator-panel").then((m) => ({ default: m.CalculatorPanel })));

/** The window event that toggles the calculator (shortcut and button). */
export const CALCULATOR_TOGGLE_EVENT = kbdEventForAction("toggle-calculator");

/** A panel that fails to load (a stale chunk after a deploy, offline)
 *  shows a small note instead of taking the page down with it. */
class CalculatorBoundary extends Component<{ children: ReactNode; onClose: () => void }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		if (!this.state.failed) return this.props.children;
		return (
			<div role="alert" className="fixed right-6 bottom-30 z-40 flex items-center gap-3 rounded-xl border bg-card px-3 py-2 text-xs text-muted-foreground shadow-lg">
				The calculator couldn&apos;t load. Reload the page to try again.
				<button type="button" onClick={this.props.onClose} className="text-foreground underline underline-offset-2">
					Close
				</button>
			</div>
		);
	}
}

export function CalculatorHost() {
	// Closed on the server; the remembered state applies after mount.
	const [open, setOpen] = useState<boolean | null>(null);
	useEffect(() => {
		setOpen(loadCalculatorState().open);
		const toggle = () => setOpen((o) => !o);
		window.addEventListener(CALCULATOR_TOGGLE_EVENT, toggle);
		return () => window.removeEventListener(CALCULATOR_TOGGLE_EVENT, toggle);
	}, []);
	useEffect(() => {
		if (open !== null) saveCalculatorState({ open });
	}, [open]);
	if (!open) return null;
	return (
		<CalculatorBoundary onClose={() => setOpen(false)}>
			<Suspense fallback={null}>
				<CalculatorPanel onClose={() => setOpen(false)} />
			</Suspense>
		</CalculatorBoundary>
	);
}
