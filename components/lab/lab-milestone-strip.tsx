"use client";

import { CheckCircle2Icon, CircleDashedIcon, PlayIcon, RotateCwIcon, XCircleIcon } from "lucide-react";
import { summarizeLabChecks, type LabNotebook } from "@/src/core";

export function LabMilestoneStrip({
	notebook,
	running,
	onJumpToCell,
	onRunAllChecks,
}: {
	notebook: LabNotebook;
	running: boolean;
	onJumpToCell: (cellId: string) => void;
	onRunAllChecks: () => void;
}) {
	const summary = summarizeLabChecks(notebook);
	if (summary.total === 0) return null;

	return (
		<div
			data-testid="lab-milestone-strip"
			className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-card/40 px-4 py-2 text-xs"
		>
			<div className="flex flex-wrap items-center gap-1.5 min-w-0">
				<span className="mr-1 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
					Milestones {summary.passed}/{summary.total}
				</span>
				{summary.checks.map((ch) => {
					const label = ch.title || `Check #${ch.index}`;
					const tone =
						ch.status === "passed"
							? "border-success/40 bg-success/10 text-success hover:bg-success/20"
							: ch.status === "failed"
								? "border-error/40 bg-error/10 text-error hover:bg-error/20"
								: ch.status === "stale"
									? "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20"
									: "border-border/80 bg-background text-muted-foreground hover:bg-accent hover:text-foreground";
					const Icon =
						ch.status === "passed"
							? CheckCircle2Icon
							: ch.status === "failed"
								? XCircleIcon
								: ch.status === "stale"
									? RotateCwIcon
									: CircleDashedIcon;

					return (
						<button
							key={ch.cellId}
							type="button"
							onClick={() => onJumpToCell(ch.cellId)}
							title={`${label} — ${ch.status.replace("_", " ")}`}
							data-testid={`lab-milestone-pill-${ch.cellId}`}
							data-milestone-status={ch.status}
							className={`inline-flex max-w-48 cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${tone}`}
						>
							<Icon className="size-3 shrink-0" />
							<span className="truncate">{label}</span>
						</button>
					);
				})}
			</div>

			<button
				type="button"
				disabled={running}
				onClick={onRunAllChecks}
				data-testid="lab-run-all-checks"
				className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/80 bg-background px-2.5 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-40"
			>
				<PlayIcon className="size-3" />
				Run checks
			</button>
		</div>
	);
}
