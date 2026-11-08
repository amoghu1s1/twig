"use client";
/**
 * THE FLOATING CALCULATOR: a small scientific calculator for trig work,
 * dragged anywhere by its title bar and styled from the app's theme tokens
 * (it matches Dark, Paper, One Dark Pro and uploaded themes alike).
 *
 * Type an expression and its result shows live; Enter saves it to the
 * history (↑/↓ recall, click a row to reuse, `ans` = the last result).
 * Angles follow the DEG/RAD switch; the button row inserts the common
 * functions at the cursor. Esc closes it. Position, mode, history and the
 * last answer are remembered per browser (state.ts). The math is engine.ts.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { calculate, type AngleMode } from "./engine";
import { clampPosition, HISTORY_LIMIT, loadCalculatorState, saveCalculatorState, type CalcHistoryEntry } from "./state";

/** The function buttons: label, what they insert at the cursor. */
export const CALCULATOR_KEYS: readonly { label: string; insert: string; title: string }[] = [
	{ label: "sin", insert: "sin(", title: "sine" },
	{ label: "cos", insert: "cos(", title: "cosine" },
	{ label: "tan", insert: "tan(", title: "tangent" },
	{ label: "sin⁻¹", insert: "asin(", title: "inverse sine" },
	{ label: "cos⁻¹", insert: "acos(", title: "inverse cosine" },
	{ label: "tan⁻¹", insert: "atan(", title: "inverse tangent" },
	{ label: "π", insert: "pi", title: "pi" },
	{ label: "√", insert: "sqrt(", title: "square root" },
	{ label: "x²", insert: "^2", title: "square" },
	{ label: "^", insert: "^", title: "power" },
];

const PANEL_WIDTH = 320;

export function CalculatorPanel({ onClose }: { onClose: () => void }) {
	const initial = useMemo(() => loadCalculatorState(), []);
	const [angle, setAngle] = useState<AngleMode>(initial.angle);
	const [history, setHistory] = useState<CalcHistoryEntry[]>(initial.history);
	// The live value `ans` refers to (any type); after a reload, the stored
	// number.
	const [ans, setAns] = useState<unknown>(initial.ans ?? undefined);
	const [input, setInput] = useState("");
	const [error, setError] = useState<string | null>(null);
	// ↑/↓ walk the history; null = editing the draft.
	const [recall, setRecall] = useState<number | null>(null);
	const [position, setPositionState] = useState(initial.position);
	// The latest position, for saving when a drag ends (outside a render).
	const positionRef = useRef(initial.position);
	const setPosition = (next: { x: number; y: number } | null) => {
		positionRef.current = next;
		setPositionState(next);
	};
	// The typed line while ↑/↓ browse the history, restored on the way back.
	const draftRef = useRef("");
	const panelRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	const live = useMemo(() => calculate(input, { angle, ans }), [input, angle, ans]);

	// Opening puts the cursor in the input.
	useEffect(() => {
		inputRef.current?.focus({ preventScroll: true });
	}, []);
	// The newest history row stays in view.
	useEffect(() => {
		const list = listRef.current;
		if (list) list.scrollTop = list.scrollHeight;
	}, [history.length]);

	// Keep the panel on screen, title bar included: the saved spot, or the
	// default top-right one, is clamped to this window, and again whenever
	// the window shrinks or the panel grows (history rows). The default stays
	// CSS-anchored while it fits.
	useEffect(() => {
		const fit = () => {
			const el = panelRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const current = positionRef.current ?? { x: rect.left, y: rect.top };
			const next = clampPosition(current, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
			if (next.x !== current.x || next.y !== current.y) setPosition(next);
		};
		fit();
		window.addEventListener("resize", fit);
		const observer = new ResizeObserver(fit);
		if (panelRef.current) observer.observe(panelRef.current);
		return () => {
			window.removeEventListener("resize", fit);
			observer.disconnect();
		};
		// Mount only: fit reads the latest position from its ref.
	}, []);

	// Dragging by the title bar (pointer capture; buttons in the bar stay clickable).
	const drag = useRef<{ dx: number; dy: number; pointer: number } | null>(null);
	const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
		if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
		const rect = panelRef.current!.getBoundingClientRect();
		drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top, pointer: e.pointerId };
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	};
	const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		const el = panelRef.current;
		if (!d || !el || d.pointer !== e.pointerId) return;
		setPosition(
			clampPosition({ x: e.clientX - d.dx, y: e.clientY - d.dy }, { width: el.offsetWidth, height: el.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }),
		);
	};
	const onDragEnd = (e: React.PointerEvent<HTMLDivElement>) => {
		if (!drag.current || drag.current.pointer !== e.pointerId) return;
		drag.current = null;
		e.currentTarget.releasePointerCapture(e.pointerId);
		if (positionRef.current) saveCalculatorState({ position: positionRef.current });
	};

	const changeAngle = (next: AngleMode) => {
		setAngle(next);
		saveCalculatorState({ angle: next });
	};

	const commit = () => {
		const result = calculate(input, { angle, ans });
		if (!result) return;
		if (!result.ok) {
			setError(result.error);
			return;
		}
		const entry = { expression: input.trim(), text: result.text };
		const nextHistory = [...history, entry].slice(-HISTORY_LIMIT);
		setHistory(nextHistory);
		setAns(result.value);
		setInput("");
		setError(null);
		setRecall(null);
		saveCalculatorState({ history: nextHistory, ans: typeof result.value === "number" && Number.isFinite(result.value) ? result.value : null });
	};

	/** Put text at the cursor (the function buttons). */
	const insert = (text: string) => {
		const el = inputRef.current;
		const start = el?.selectionStart ?? input.length;
		const end = el?.selectionEnd ?? input.length;
		const next = input.slice(0, start) + text + input.slice(end);
		setInput(next);
		setError(null);
		requestAnimationFrame(() => {
			el?.focus({ preventScroll: true });
			el?.setSelectionRange(start + text.length, start + text.length);
		});
	};

	const recallStep = (dir: -1 | 1) => {
		if (history.length === 0) return;
		if (recall === null) draftRef.current = input;
		const from = recall ?? history.length;
		const to = Math.min(Math.max(from + dir, 0), history.length);
		setRecall(to === history.length ? null : to);
		setInput(to === history.length ? draftRef.current : history[to]!.expression);
		setError(null);
	};

	const reset = () => {
		setHistory([]);
		setAns(undefined);
		saveCalculatorState({ history: [], ans: null });
	};

	return (
		<div
			ref={panelRef}
			role="dialog"
			aria-label="Calculator"
			data-testid="calculator"
			data-calculator=""
			onKeyDown={(e) => {
				// Esc anywhere in the calculator closes it, and never reaches the
				// page's own Esc handling (which could skip a question). Tab stays
				// put: the app's Tab cycles the page's text fields, which would
				// pull focus out mid-calculation.
				if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
					e.preventDefault();
					e.stopPropagation();
					return;
				}
				if (e.key !== "Escape") return;
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}}
			className="fixed z-40 flex flex-col rounded-2xl border bg-card text-card-foreground shadow-lg"
			style={{
				width: PANEL_WIDTH,
				// Default: top right, clear of the answer box and its Submit button.
				...(position ? { left: position.x, top: position.y } : { right: 24, top: 72 }),
			}}
		>
			<div
				onPointerDown={onDragStart}
				onPointerMove={onDragMove}
				onPointerUp={onDragEnd}
				onPointerCancel={onDragEnd}
				data-testid="calculator-titlebar"
				className="flex cursor-move touch-none select-none items-center gap-2 px-3 pt-2.5 pb-1.5"
			>
				<span className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">Calculator</span>
				<div role="radiogroup" aria-label="Angle unit" className="ml-auto flex rounded-md bg-muted p-0.5 font-ui text-xs">
					{(["deg", "rad"] as const).map((mode) => (
						<button
							key={mode}
							type="button"
							role="radio"
							aria-checked={angle === mode}
							data-testid={`calculator-${mode}`}
							onClick={() => changeAngle(mode)}
							className={cn(
								"rounded-[5px] px-2 py-0.5 uppercase transition-colors",
								angle === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{mode}
						</button>
					))}
				</div>
				<button
					type="button"
					aria-label="Close the calculator"
					onClick={onClose}
					className="rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3.5" />
				</button>
			</div>

			{history.length > 0 && (
				<div ref={listRef} data-testid="calculator-history" className="flex max-h-48 flex-col gap-0.5 overflow-y-auto px-1.5 pb-1">
					{history.map((entry, i) => (
						<div key={i} className="group/row flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-accent">
							<button
								type="button"
								onClick={() => {
									setInput(entry.expression);
									setRecall(null);
									setError(null);
									inputRef.current?.focus({ preventScroll: true });
								}}
								title="Use this expression"
								className="flex min-w-0 flex-1 items-baseline justify-between gap-3 text-left font-mono text-sm"
							>
								<span className="min-w-0 truncate text-muted-foreground">{entry.expression}</span>
								<span className="shrink-0 tabular-nums">= {entry.text}</span>
							</button>
							<CopyButton text={entry.text} className="opacity-0 group-hover/row:opacity-100" />
						</div>
					))}
				</div>
			)}

			<div className="px-1.5 pb-1.5">
				<div className="rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
					<input
						ref={inputRef}
						type="text"
						data-testid="calculator-input"
						value={input}
						spellCheck={false}
						autoComplete="off"
						aria-label="Expression"
						placeholder={angle === "deg" ? "sin(30) · atan2(3, 4) · ans * 2" : "sin(pi/6) · atan2(3, 4) · ans * 2"}
						onChange={(e) => {
							setInput(e.target.value);
							setError(null);
							setRecall(null);
						}}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								e.stopPropagation();
								commit();
							} else if (e.key === "ArrowUp") {
								e.preventDefault();
								recallStep(-1);
							} else if (e.key === "ArrowDown") {
								e.preventDefault();
								recallStep(1);
							}
						}}
						className="lh-input w-full bg-transparent px-2.5 pt-2 pb-1 font-mono text-sm outline-none placeholder:text-muted-foreground/60"
					/>
					<div className="flex min-h-7 items-center gap-1 px-2.5 pb-1.5 font-mono text-sm" aria-live="polite">
						{error ? (
							<span role="alert" data-testid="calculator-error" className="min-w-0 truncate text-xs text-error">
								{error}
							</span>
						) : live?.ok ? (
							<>
								<span data-testid="calculator-result" className="min-w-0 truncate tabular-nums text-muted-foreground">
									= {live.text}
								</span>
								<CopyButton text={live.text} />
							</>
						) : (
							<span className="text-xs text-muted-foreground/60">{angle === "deg" ? "Angles in degrees" : "Angles in radians"}</span>
						)}
					</div>
				</div>
			</div>

			<div className="grid grid-cols-5 gap-1 px-1.5 pb-1.5">
				{CALCULATOR_KEYS.map((key) => (
					<button
						key={key.label}
						type="button"
						title={key.title}
						onClick={() => insert(key.insert)}
						className="rounded-md border border-border/60 py-1 font-mono text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
					>
						{key.label}
					</button>
				))}
			</div>
			<div className="flex items-center justify-between px-3 pb-2 font-ui text-xs text-muted-foreground/70">
				<span>log = base 10 · ln = natural</span>
				{history.length > 0 && (
					<button type="button" onClick={reset} className="transition-colors hover:text-foreground">
						Clear history
					</button>
				)}
			</div>
		</div>
	);
}

function CopyButton({ text, className }: { text: string; className?: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			aria-label={`Copy ${text}`}
			onClick={() => {
				void navigator.clipboard
					?.writeText(text)
					.then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1200);
					})
					.catch(() => {/* clipboard blocked: nothing copied, nothing to show */});
			}}
			className={cn("shrink-0 rounded-sm p-0.5 text-muted-foreground transition-[color,opacity] hover:text-foreground", className)}
		>
			{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
		</button>
	);
}
