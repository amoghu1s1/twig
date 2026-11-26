"use client";

import { useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { SvgImage } from "@/components/artifacts/svg-image";
import { PracticeDockActionBar } from "@/components/practice-dock-actions";
import { cn } from "@/lib/utils";
import {
	gradePracticeCheck,
	normalizeOptions,
	parsePracticeCheckInput,
	seededRandom,
	shuffleOptions,
	type PracticeThinkingAction,
} from "@/src/core";

export interface PracticeCheckDockProps {
	problemCallId: string;
	input: unknown;
	expanded: boolean;
	onExpand: () => void;
	onSubmitStructured: (submission: {
		format: "check";
		payload: Record<string, unknown>;
		passed: boolean;
		thinking?: string;
		summaryText: string;
	}) => void;
	onAction: (action: Exclude<PracticeThinkingAction, "submit">, text: string) => void;
	onEscape?: () => void;
	compactionRunning?: boolean;
}

/**
 * Interactive single/multi-select dock for `practice_check`.
 * Grades instantaneously on submit via `gradePracticeCheck` and preserves
 * selections across scroll collapse (`hidden={!expanded}`).
 */
export function PracticeCheckDock({
	problemCallId,
	input,
	expanded,
	onExpand,
	onSubmitStructured,
	onAction,
	onEscape,
	compactionRunning = false,
}: PracticeCheckDockProps) {
	const parsed = useMemo(() => parsePracticeCheckInput(input), [input]);
	const options = useMemo(() => {
		if (!parsed) return [];
		return shuffleOptions(normalizeOptions(parsed.options), seededRandom(problemCallId));
	}, [parsed, problemCallId]);

	const [selected, setSelected] = useState<string[]>([]);
	const [thinking, setThinking] = useState("");
	const [missedBanner, setMissedBanner] = useState<string | null>(null);
	const thinkingRef = useRef(thinking);
	thinkingRef.current = thinking;

	if (!parsed) return null;

	const toggle = (value: string) => {
		setMissedBanner(null);
		if (parsed.multiSelect) {
			setSelected((prev) =>
				prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
			);
		} else {
			setSelected([value]);
		}
	};

	const submit = () => {
		if (selected.length === 0 || compactionRunning) return;
		const grade = gradePracticeCheck(parsed, selected);
		const labelByVal = new Map(options.map((o) => [o.value, o.label]));
		const chosenLabels = selected.map((v) => labelByVal.get(v) ?? v);
		const summaryText = chosenLabels.join(", ");
		const note = thinkingRef.current.trim();
		if (!grade.correct) {
			setMissedBanner("Not quite — review your choice or ask for a hint.");
		} else {
			setMissedBanner(null);
		}
		onSubmitStructured({
			format: "check",
			payload: {
				selected,
				selectedLabels: chosenLabels,
				expectedValues: grade.expectedValues,
				missedValues: grade.missedValues,
				extraValues: grade.extraValues,
			},
			passed: grade.correct,
			...(note ? { thinking: note } : {}),
			summaryText,
		});
		setThinking("");
	};

	const handleDockAction = (action: Exclude<PracticeThinkingAction, "submit">) => {
		const note = thinkingRef.current.trim();
		onAction(action, note);
		if (action !== "hint") setThinking("");
	};

	return (
		<div data-testid="practice-check-dock">
			{!expanded && (
				<button
					type="button"
					data-testid="practice-dock-collapsed"
					onClick={onExpand}
					className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
				>
					<span className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Quick check
					</span>
					<span className="min-w-0 flex-1 truncate text-sm text-foreground">{parsed.statement}</span>
					<ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
				</button>
			)}
			<div hidden={!expanded} className="space-y-3 p-2">
				<div data-session-find-root="" className="max-h-[var(--dock-max-h,50dvh)] space-y-2.5 overflow-y-auto px-2 pt-2">
					<div className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Quick check{parsed.multiSelect ? " · Select all that apply" : ""}
					</div>
					<div className="lh-prose text-sm">
						<ToolContentResponse>{parsed.statement}</ToolContentResponse>
					</div>
					{parsed.svg && (
						<div className="my-2">
							<SvgImage svg={parsed.svg} />
						</div>
					)}
					<div className="space-y-1.5">
						{options.map((opt, idx) => {
							const active = selected.includes(opt.value);
							return (
								<button
									key={opt.value}
									type="button"
									data-testid={`practice-check-option-${idx}`}
									aria-pressed={active}
									disabled={compactionRunning}
									onClick={() => toggle(opt.value)}
									className={cn(
										"flex w-full cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
										active
											? "border-primary bg-primary/10 text-foreground"
											: "border-border/70 bg-background/50 text-foreground hover:border-border hover:bg-accent/40",
									)}
								>
									<span
										aria-hidden
										className={cn(
											"mt-0.5 flex size-4 shrink-0 items-center justify-center border",
											parsed.multiSelect ? "rounded" : "rounded-full",
											active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
										)}
									>
										{active && <CheckIcon className="size-3" />}
									</span>
									<span className="min-w-0 flex-1">
										<ToolContentResponse>{opt.label}</ToolContentResponse>
									</span>
								</button>
							);
						})}
					</div>
					{missedBanner && (
						<p data-testid="practice-check-miss" role="status" className="text-xs text-error">
							{missedBanner}
						</p>
					)}
				</div>

				<div className="rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
					<input
						type="text"
						data-testid="practice-check-thinking"
						value={thinking}
						onChange={(e) => setThinking(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape" && onEscape) {
								e.preventDefault();
								e.stopPropagation();
								onEscape();
								return;
							}
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								submit();
							}
						}}
						placeholder="Why? (optional)"
						className="w-full bg-transparent px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground/70"
					/>
					<PracticeDockActionBar
						disabled={compactionRunning}
						onAction={handleDockAction}
						submitButton={
							<Button
								type="button"
								data-testid="practice-send"
								disabled={selected.length === 0 || compactionRunning}
								onClick={submit}
								className="h-9 rounded-[6px] px-3.5 text-sm font-medium"
							>
								Check answer
							</Button>
						}
					/>
				</div>
			</div>
		</div>
	);
}
