"use client";

import { useState } from "react";
import { AlertTriangleIcon, BookOpenIcon, CheckCircle2Icon, RepeatIcon } from "lucide-react";
import {
	buildPracticeSeededRequest,
	parsePracticeSummaryInput,
	type ArtifactPartProps,
	type GraphSnapshot,
	type PracticeSummaryItem,
} from "@/src/core";
import { SessionStarter } from "@/components/start-session";
import { ToolContentResponse } from "@/components/ai-elements/message";

export function PracticeSummaryCard({ part }: ArtifactPartProps) {
	const [busyKind, setBusyKind] = useState<"teach" | "practice" | null>(null);
	const [error, setError] = useState<string | null>(null);

	const data = parsePracticeSummaryInput(part.output ?? part.input);
	if (!data) {
		return (
			<div data-testid="practice-summary-card" className="my-2 rounded-xl border bg-card p-4 text-xs text-muted-foreground">
				Preparing session recap…
			</div>
		);
	}

	const launchFollowUp = async (items: readonly PracticeSummaryItem[], targetKind: "teach" | "practice") => {
		if (items.length === 0 || busyKind !== null) return;
		setBusyKind(targetKind);
		setError(null);
		try {
			let allNodes: GraphSnapshot["propositions"] = [];
			try {
				const res = await fetch("/api/graph");
				if (res.ok) {
					const snap = (await res.json()) as GraphSnapshot;
					allNodes = snap.propositions ?? [];
				}
			} catch {
				// Proceed pickless if graph snapshot is unavailable.
			}
			const seeded = buildPracticeSeededRequest(items, targetKind, allNodes);
			const url = await new SessionStarter().start(
				{
					title: seeded.title,
					...(seeded.kind ? { kind: seeded.kind } : {}),
					...(seeded.graphContext ? { graphContext: seeded.graphContext } : {}),
				},
				fetch,
				undefined,
				undefined,
				seeded.openingPrompt,
			);
			const bridge = (window as unknown as { lh?: { navigate?: (url: string) => void } }).lh;
			if (bridge?.navigate) bridge.navigate(url);
			else window.location.assign(url);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not start follow-up session");
			setBusyKind(null);
		}
	};

	return (
		<div data-testid="practice-summary-card" className="lh-card-enter my-2 space-y-3 rounded-xl border bg-card p-4 text-sm">
			<div className="flex items-center justify-between gap-2">
				<span className="font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
					Session recap
				</span>
			</div>
			<div className="lh-prose text-[15px]">
				<ToolContentResponse>{data.summary}</ToolContentResponse>
			</div>

			{data.solid.length > 0 && (
				<div className="space-y-1.5 border-t border-border/60 pt-2.5">
					<div className="flex items-center gap-1.5 font-ui text-xs font-medium uppercase tracking-wide text-success">
						<CheckCircle2Icon className="size-3.5" aria-hidden />
						Solid
					</div>
					<ul className="space-y-1 text-xs">
						{data.solid.map((item, i) => (
							<li key={i} className="leading-relaxed">
								<span className="font-medium text-foreground">{item.area}</span>
								<span className="text-muted-foreground"> — {item.note}</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{data.needsPractice.length > 0 && (
				<div className="space-y-2 border-t border-border/60 pt-2.5">
					<div className="flex items-center justify-between gap-2">
						<span className="flex items-center gap-1.5 font-ui text-xs font-medium uppercase tracking-wide text-warning">
							<RepeatIcon className="size-3.5" aria-hidden />
							Needs more practice
						</span>
						<button
							type="button"
							data-testid="practice-again-btn"
							disabled={busyKind !== null}
							onClick={() => void launchFollowUp(data.needsPractice, "practice")}
							className="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2.5 py-1 font-ui text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
						>
							<RepeatIcon className="size-3" aria-hidden />
							{busyKind === "practice" ? "Starting…" : "Practice these again"}
						</button>
					</div>
					<ul className="space-y-1 text-xs">
						{data.needsPractice.map((item, i) => (
							<li key={i} className="leading-relaxed">
								<span className="font-medium text-foreground">{item.area}</span>
								<span className="text-muted-foreground"> — {item.note}</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{data.remedialTeach.length > 0 && (
				<div className="space-y-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
					<div className="flex items-center justify-between gap-2">
						<span className="flex items-center gap-1.5 font-ui text-xs font-medium uppercase tracking-wide text-foreground">
							<AlertTriangleIcon className="size-3.5 text-warning" aria-hidden />
							Recommended remedial Teach
						</span>
						<button
							type="button"
							data-testid="practice-remedial-teach-btn"
							disabled={busyKind !== null}
							onClick={() => void launchFollowUp(data.remedialTeach, "teach")}
							className="flex cursor-pointer items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 font-ui text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
						>
							<BookOpenIcon className="size-3" aria-hidden />
							{busyKind === "teach" ? "Starting…" : "Start remedial Teach"}
						</button>
					</div>
					<ul className="space-y-1.5 text-xs">
						{data.remedialTeach.map((item, i) => (
							<li key={i} className="leading-relaxed">
								<span className="font-medium text-foreground">{item.area}</span>
								<span className="text-muted-foreground"> — {item.note}</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{error && (
				<p role="alert" className="text-xs text-destructive">
					{error}
				</p>
			)}
		</div>
	);
}
