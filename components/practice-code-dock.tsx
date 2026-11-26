"use client";

import { useLayoutEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from "react";
import { CheckIcon, ChevronRightIcon, PlayIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { HighlightedCode } from "@/components/highlighted-code";
import { codeRuntimeFor } from "@/components/code-runtime";
import { PracticeDockActionBar } from "@/components/practice-dock-actions";
import { cn } from "@/lib/utils";
import {
	canRun,
	canSubmit,
	CODE_LANGUAGE_LABELS,
	CODE_RUN_TIMEOUT_MS,
	exerciseReducer,
	initialExerciseState,
	insertIndent,
	isRunShortcut,
	lastRunIsCurrent,
	parsePracticeCodeInput,
	restoreLiteralNewlines,
	type CodeRuntime,
	type PracticeThinkingAction,
} from "@/src/core";

export interface PracticeCodeDockProps {
	problemCallId: string;
	input: unknown;
	expanded: boolean;
	onExpand: () => void;
	onSubmitStructured: (submission: {
		format: "code";
		payload: Record<string, unknown>;
		passed: boolean;
		thinking?: string;
		summaryText: string;
	}) => void;
	onAction: (action: Exclude<PracticeThinkingAction, "submit">, text: string) => void;
	onEscape?: () => void;
	compactionRunning?: boolean;
	runtimeOverride?: CodeRuntime;
}

/**
 * Interactive runnable code dock for `practice_code`.
 * Reuses Twig's existing browser/local code runtimes (`python`, `javascript`,
 * `typescript`, `cpp`) and runs tests before submitting cleanly.
 */
export function PracticeCodeDock({
	input,
	expanded,
	onExpand,
	onSubmitStructured,
	onAction,
	onEscape,
	compactionRunning = false,
	runtimeOverride,
}: PracticeCodeDockProps) {
	const parsed = useMemo(() => parsePracticeCodeInput(input), [input]);
	const starter = parsed?.starterCode ?? "";
	const [state, dispatch] = useReducer(exerciseReducer, starter, initialExerciseState);
	const [thinking, setThinking] = useState("");
	const thinkingRef = useRef(thinking);
	thinkingRef.current = thinking;
	const editorRef = useRef<HTMLTextAreaElement>(null);
	const highlightRef = useRef<HTMLDivElement>(null);
	const pendingCaret = useRef<number | null>(null);

	useLayoutEffect(() => {
		if (pendingCaret.current === null) return;
		editorRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
		pendingCaret.current = null;
	}, [state.code]);

	if (!parsed) return null;

	const runtime = runtimeOverride ?? codeRuntimeFor(parsed.language);
	const graded = parsed.tests !== undefined;
	const submittable = canSubmit(state) && !compactionRunning;
	const current = lastRunIsCurrent(state);

	const run = async () => {
		if (!canRun(state)) return;
		const code = state.code;
		dispatch({ type: "run-start" });
		try {
			const result = await runtime.run({
				code,
				tests: parsed.tests,
				timeoutMs: CODE_RUN_TIMEOUT_MS,
			});
			dispatch({ type: "run-done", ranCode: code, result });
		} catch (err) {
			dispatch({
				type: "run-failed",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	};

	const submit = () => {
		if (!submittable || !state.lastRun) return;
		const lastRun = state.lastRun;
		const passed = graded
			? lastRun.passed === true
			: !lastRun.error && !lastRun.timedOut;
		const note = thinkingRef.current.trim();
		const statusLabel = lastRun.timedOut
			? "Timed out"
			: passed
				? graded
					? "Tests passed"
					: "Ran cleanly"
				: "Failed checks";
		const summaryText = `${CODE_LANGUAGE_LABELS[parsed.language]} · ${statusLabel} (${state.runs} run${state.runs === 1 ? "" : "s"})`;
		onSubmitStructured({
			format: "code",
			payload: {
				language: parsed.language,
				code: state.code,
				runs: state.runs,
				lastRun,
			},
			passed,
			...(note ? { thinking: note } : {}),
			summaryText,
		});
		setThinking("");
	};

	const onEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		if (isRunShortcut(event)) {
			event.preventDefault();
			void run();
			return;
		}
		if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
			event.preventDefault();
			const editor = event.currentTarget;
			const next = insertIndent(editor.value, editor.selectionStart, editor.selectionEnd);
			pendingCaret.current = next.caret;
			dispatch({ type: "edit", code: next.value });
		}
	};

	const handleDockAction = (action: Exclude<PracticeThinkingAction, "submit">) => {
		onAction(action, thinkingRef.current.trim());
		if (action !== "hint") setThinking("");
	};

	return (
		<div data-testid="practice-code-dock">
			{!expanded && (
				<button
					type="button"
					data-testid="practice-dock-collapsed"
					onClick={onExpand}
					className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
				>
					<span className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Code · {CODE_LANGUAGE_LABELS[parsed.language]}
					</span>
					<span className="min-w-0 flex-1 truncate text-sm text-foreground">{parsed.statement}</span>
					<ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
				</button>
			)}
			<div hidden={!expanded} className="space-y-2 p-2">
				<div data-session-find-root="" className="max-h-[var(--dock-max-h,50dvh)] space-y-2 overflow-y-auto px-2 pt-2">
					<div className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Code · {CODE_LANGUAGE_LABELS[parsed.language]}
					</div>
					<div className="lh-prose text-sm">
						<ToolContentResponse>{restoreLiteralNewlines(parsed.statement)}</ToolContentResponse>
					</div>

					<div className="rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
						<div className="relative">
							<pre
								aria-hidden
								className="pointer-events-none absolute inset-0 overflow-hidden px-2.5 py-2 font-mono text-sm leading-relaxed"
							>
								<span ref={highlightRef} className="block whitespace-pre">
									<HighlightedCode code={state.code} language={parsed.language} />
								</span>
							</pre>
							<textarea
								ref={editorRef}
								data-testid="practice-code-editor"
								aria-label="Your code"
								value={state.code}
								onChange={(e) => dispatch({ type: "edit", code: e.target.value })}
								onKeyDown={onEditorKeyDown}
								onScroll={(e) => {
									if (highlightRef.current) {
										highlightRef.current.style.transform = `translate(${-e.currentTarget.scrollLeft}px, ${-e.currentTarget.scrollTop}px)`;
									}
								}}
								spellCheck={false}
								autoCapitalize="off"
								autoCorrect="off"
								wrap="off"
								rows={1}
								className="relative block field-sizing-content min-h-28 max-h-64 w-full resize-none overflow-auto whitespace-pre bg-transparent px-2.5 py-2 font-mono text-sm leading-relaxed text-transparent caret-foreground outline-none"
							/>
						</div>
					</div>

					<div className="flex items-center gap-3">
						<Button
							type="button"
							variant="secondary"
							size="sm"
							data-testid="practice-code-run"
							disabled={!canRun(state)}
							onClick={() => void run()}
						>
							<PlayIcon />
							Run
						</Button>
						{state.running ? (
							<span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
								<BrailleSpinner /> Running…
							</span>
						) : state.runtimeError ? (
							<span className="text-xs text-error">{state.runtimeError}</span>
						) : state.lastRun ? (
							<span
								className={cn(
									"inline-flex items-center gap-1 text-xs",
									!current && "opacity-60",
									state.lastRun.passed === true
										? "text-success"
										: state.lastRun.error || state.lastRun.passed === false || state.lastRun.timedOut
											? "text-error"
											: "text-muted-foreground",
								)}
							>
								{state.lastRun.passed === true ? (
									<CheckIcon className="size-3.5" />
								) : state.lastRun.passed === false || state.lastRun.error ? (
									<XIcon className="size-3.5" />
								) : null}
								{state.lastRun.timedOut
									? "Timed out"
									: state.lastRun.passed === true
										? "All tests passed"
										: state.lastRun.passed === false
											? "Tests failed"
											: state.lastRun.error
												? "Error"
												: "Ran cleanly"}
								{!current && " (outdated)"}
							</span>
						) : (
							<span className="text-xs text-muted-foreground">Run before submitting (⌘↵)</span>
						)}
					</div>

					{state.lastRun && (state.lastRun.stdout || state.lastRun.error) && (
						<pre className="max-h-32 overflow-auto rounded-lg border border-border/60 bg-background/70 p-2 font-mono text-xs text-foreground">
							{state.lastRun.stdout}
							{state.lastRun.error ? `\n${state.lastRun.error}` : ""}
						</pre>
					)}
				</div>

				<div className="rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
					<input
						type="text"
						data-testid="practice-code-thinking"
						value={thinking}
						onChange={(e) => setThinking(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape" && onEscape) {
								e.preventDefault();
								e.stopPropagation();
								onEscape();
							}
						}}
						placeholder="Notes or reasoning (optional)"
						className="w-full bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70"
					/>
					<PracticeDockActionBar
						disabled={compactionRunning}
						onAction={handleDockAction}
						submitButton={
							<Button
								type="button"
								data-testid="practice-send"
								disabled={!submittable}
								onClick={submit}
								className="h-9 rounded-[6px] px-3.5 text-sm font-medium"
							>
								Submit code
							</Button>
						}
					/>
				</div>
			</div>
		</div>
	);
}
