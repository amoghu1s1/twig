"use client";

import { useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, RotateCcwIcon } from "lucide-react";
import { foldPracticeLedger, type LhMessage, type TargetPracticeStatus } from "@/src/core";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<TargetPracticeStatus, { label: string; cls: string }> = {
	solid: { label: "Solid", cls: "border-success/30 bg-success/10 text-success" },
	shaky: { label: "Shaky", cls: "border-warning/30 bg-warning/10 text-warning" },
	missed: { label: "Missed", cls: "border-error/30 bg-error/10 text-error" },
	untested: { label: "Untested", cls: "border-border/70 text-muted-foreground" },
};

const MODE_SHORT: Record<string, string> = {
	recall: "R",
	discrimination: "D",
	composition: "C",
};

/**
 * Slim clickable progress strip mounted beneath PracticeToolbar:
 * displays live problem/target/retest counts from `foldPracticeLedger`
 * and expands to show per-target mastery & modes tested.
 */
export function PracticeProgressStrip({ messages }: { messages: readonly LhMessage[] }) {
	const [open, setOpen] = useState(false);
	const ledger = useMemo(() => foldPracticeLedger(messages), [messages]);

	if (ledger.problemsAttempted === 0 && ledger.targets.length === 0) return null;

	const touched = ledger.targets.filter((t) => t.attempts > 0).length;
	const parts: string[] = [
		`${ledger.problemsAttempted} ${ledger.problemsAttempted === 1 ? "problem" : "problems"}`,
	];
	if (ledger.targets.length > 0) {
		parts.push(`${touched}/${ledger.targets.length} targets touched`);
	} else {
		parts.push(`${ledger.problemsSolved} solved cleanly`);
	}
	if (ledger.retestQueue.length > 0) {
		parts.push(`${ledger.retestQueue.length} to retest`);
	}

	return (
		<div data-testid="practice-progress-strip" className="border-b border-border/50 bg-background/80 px-4">
			<div className="mx-auto w-full max-w-[46rem]">
				<button
					type="button"
					data-testid="practice-progress-toggle"
					aria-expanded={open}
					disabled={ledger.targets.length === 0 && ledger.retestQueue.length === 0}
					onClick={() => setOpen((v) => !v)}
					className="flex w-full cursor-pointer items-center gap-2 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
				>
					{(ledger.targets.length > 0 || ledger.retestQueue.length > 0) &&
						(open ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" />)}
					<span className="tabular-nums">{parts.join(" · ")}</span>
				</button>
				{open && (
					<div data-testid="practice-progress-panel" className="mb-2 space-y-2 rounded-lg border bg-card p-3 text-xs">
						{ledger.targets.length > 0 && (
							<div className="space-y-1.5">
								{ledger.targets.map((t) => {
									const st = STATUS_STYLE[t.status];
									return (
										<div key={t.id} className="flex items-center gap-2">
											<span className={cn("rounded-full border px-2 py-0.5 font-ui text-[10px] font-medium", st.cls)}>
												{st.label}
											</span>
											<span className="min-w-0 flex-1 truncate font-medium text-foreground">{t.name}</span>
											{t.modesTested.length > 0 && (
												<span className="font-mono text-[10px] text-muted-foreground">
													{t.modesTested.map((m) => MODE_SHORT[m] ?? m).join(" · ")}
												</span>
											)}
											{t.needsRetest && (
												<span className="inline-flex items-center gap-1 text-[10px] text-warning">
													<RotateCcwIcon className="size-2.5" /> retest
												</span>
											)}
										</div>
									);
								})}
							</div>
						)}
						{ledger.retestQueue.length > 0 && (
							<div className="border-t border-border/60 pt-2 text-[11px] text-muted-foreground">
								<span className="font-medium text-foreground">Queued for fresh-surface retest: </span>
								{ledger.retestQueue.map((r) => r.targetNames.join(", ") || "untagged").join("; ")}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
