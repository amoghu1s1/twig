"use client";

import { useMemo, useRef, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { PracticeDockActionBar } from "@/components/practice-dock-actions";
import { cn } from "@/lib/utils";
import {
	gradePracticeMatch,
	parsePracticeMatchInput,
	type PracticeThinkingAction,
} from "@/src/core";

export interface PracticeMatchDockProps {
	problemCallId: string;
	input: unknown;
	expanded: boolean;
	onExpand: () => void;
	onSubmitStructured: (submission: {
		format: "match";
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
 * Interactive classification / pair-matching dock for `practice_match`.
 * Grades instantaneously via `gradePracticeMatch`, surfacing per-item pass/miss
 * states immediately and keeping mappings editable after a miss.
 */
export function PracticeMatchDock({
	input,
	expanded,
	onExpand,
	onSubmitStructured,
	onAction,
	onEscape,
	compactionRunning = false,
}: PracticeMatchDockProps) {
	const parsed = useMemo(() => parsePracticeMatchInput(input), [input]);
	const [mapping, setMapping] = useState<Record<string, string>>({});
	const [thinking, setThinking] = useState("");
	const [perItemFeedback, setPerItemFeedback] = useState<Record<string, boolean> | null>(null);
	const thinkingRef = useRef(thinking);
	thinkingRef.current = thinking;

	if (!parsed) return null;

	const allMatched = parsed.items.every((it) => Boolean(mapping[it.id]));

	const assign = (itemId: string, catId: string) => {
		setMapping((prev) => ({ ...prev, [itemId]: catId }));
		setPerItemFeedback((prev) => {
			if (!prev) return null;
			const next = { ...prev };
			delete next[itemId];
			return next;
		});
	};

	const submit = () => {
		if (!allMatched || compactionRunning) return;
		const grade = gradePracticeMatch(parsed, mapping);
		const catLabelById = new Map(parsed.categories.map((c) => [c.id, c.label]));
		const lines = parsed.items.map((it) => {
			const catLabel = catLabelById.get(mapping[it.id] ?? "") ?? mapping[it.id] ?? "—";
			return `${it.prompt} → ${catLabel}`;
		});
		const summaryText = `${grade.score.right}/${grade.score.total} matched\n${lines.join("\n")}`;
		const note = thinkingRef.current.trim();
		setPerItemFeedback(grade.correct ? null : grade.perItem);
		onSubmitStructured({
			format: "match",
			payload: {
				mapping,
				perItem: grade.perItem,
				score: grade.score,
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
		<div data-testid="practice-match-dock">
			{!expanded && (
				<button
					type="button"
					data-testid="practice-dock-collapsed"
					onClick={onExpand}
					className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent/50"
				>
					<span className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Classify &amp; Match
					</span>
					<span className="min-w-0 flex-1 truncate text-sm text-foreground">{parsed.statement}</span>
					<ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
				</button>
			)}
			<div hidden={!expanded} className="space-y-3 p-2">
				<div data-session-find-root="" className="max-h-[var(--dock-max-h,50dvh)] space-y-2.5 overflow-y-auto px-2 pt-2">
					<div className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
						Classify &amp; Match
					</div>
					<div className="lh-prose text-sm">
						<ToolContentResponse>{parsed.statement}</ToolContentResponse>
					</div>
					<div className="space-y-2">
						{parsed.items.map((item) => {
							const chosen = mapping[item.id];
							const status = perItemFeedback?.[item.id];
							return (
								<div
									key={item.id}
									data-testid={`practice-match-item-${item.id}`}
									className={cn(
										"space-y-1.5 rounded-lg border px-3 py-2",
										status === false
											? "border-error/60 bg-error/5"
											: status === true
												? "border-success/50 bg-success/5"
												: "border-border/70 bg-background/50",
									)}
								>
									<div className="text-sm text-foreground">
										<ToolContentResponse>{item.prompt}</ToolContentResponse>
									</div>
									<div className="flex flex-wrap gap-1.5">
										{parsed.categories.map((cat) => {
											const active = chosen === cat.id;
											return (
												<button
													key={cat.id}
													type="button"
													data-testid={`practice-match-pick-${item.id}-${cat.id}`}
													aria-pressed={active}
													disabled={compactionRunning}
													onClick={() => assign(item.id, cat.id)}
													className={cn(
														"cursor-pointer rounded-md border px-2 py-1 text-xs font-medium transition-colors",
														active
															? "border-primary bg-primary text-primary-foreground"
															: "border-border/70 bg-background text-muted-foreground hover:border-border hover:text-foreground",
													)}
												>
													{cat.label}
												</button>
											);
										})}
									</div>
								</div>
							);
						})}
					</div>
				</div>

				<div className="rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
					<input
						type="text"
						data-testid="practice-match-thinking"
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
								disabled={!allMatched || compactionRunning}
								onClick={submit}
								className="h-9 rounded-[6px] px-3.5 text-sm font-medium"
							>
								Check matches
							</Button>
						}
					/>
				</div>
			</div>
		</div>
	);
}
