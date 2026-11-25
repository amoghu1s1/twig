"use client";

import { useState } from "react";
import {
	ArrowUpRightIcon,
	CheckCircle2Icon,
	Code2Icon,
	CompassIcon,
	DumbbellIcon,
	FileTextIcon,
	Trash2Icon,
} from "lucide-react";
import { SessionStarter } from "@/components/start-session";
import { buildLabSeededRequest, parseLabSummaryInput, type ArtifactPartProps, type GraphSnapshot } from "@/src/core";
import { useLabBridge } from "./lab-context";

interface LabMutationDetails {
	cellId?: unknown;
	index?: unknown;
	role?: unknown;
	title?: unknown;
}

function readDetails(part: ArtifactPartProps["part"]): LabMutationDetails {
	if (part.output && typeof part.output === "object" && !Array.isArray(part.output)) {
		return part.output as LabMutationDetails;
	}
	return {};
}

export function LabCellMutationCard({ part }: ArtifactPartProps) {
	const bridge = useLabBridge();
	const tool = part.type.replace(/^tool-/, "");
	const failed = part.state === "output-error";
	const details = readDetails(part);
	const input = (part.input && typeof part.input === "object" ? part.input : {}) as {
		role?: unknown;
		cellType?: unknown;
		title?: unknown;
	};

	const cellId = typeof details.cellId === "string" ? details.cellId : undefined;
	const index = typeof details.index === "number" ? details.index : undefined;
	const role = typeof details.role === "string"
		? details.role
		: typeof input.role === "string"
			? input.role
			: typeof input.cellType === "string"
				? input.cellType
				: "cell";
	const title = typeof details.title === "string"
		? details.title
		: typeof input.title === "string"
			? input.title
			: undefined;

	const verb =
		tool === "insert_cell"
			? "Inserted"
			: tool === "update_mentor_cell"
				? "Updated"
				: "Removed";

	const Icon =
		tool === "delete_mentor_cell"
			? Trash2Icon
			: role === "check"
				? CheckCircle2Icon
				: role === "markdown"
					? FileTextIcon
					: Code2Icon;

	if (failed) {
		return (
			<div className="my-1.5 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
				{tool} failed — cell protected or unavailable.
			</div>
		);
	}

	return (
		<div
			data-testid={`lab-tool-card-${tool}`}
			className="my-1.5 flex items-center justify-between gap-2 rounded-lg border border-border/80 bg-card px-3 py-2 text-xs"
		>
			<div className="flex min-w-0 items-center gap-2">
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="truncate text-foreground">
					{verb} {role} cell{index !== undefined ? ` #${index}` : ""}
					{title ? ` · ${title}` : ""}
				</span>
			</div>
			{cellId && tool !== "delete_mentor_cell" && bridge && (
				<button
					type="button"
					onClick={() => bridge.jumpToCell(cellId)}
					className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent"
				>
					Jump to cell
					<ArrowUpRightIcon className="size-3" />
				</button>
			)}
		</div>
	);
}

export function LabSummaryCard({ part }: ArtifactPartProps) {
	const bridge = useLabBridge();
	const [busyKind, setBusyKind] = useState<"teach" | "practice" | null>(null);
	const [error, setError] = useState<string | null>(null);

	if (part.state === "output-error") {
		return (
			<div className="my-2 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs text-error">
				Could not record Lab summary.
			</div>
		);
	}

	const data = parseLabSummaryInput(part.output ?? part.input);
	if (!data) return null;

	const startSeeded = async (targetKind: "teach" | "practice") => {
		if (busyKind) return;
		setBusyKind(targetKind);
		setError(null);
		try {
			let allNodes: GraphSnapshot["propositions"] = [];
			try {
				const graphRes = await fetch("/api/graph");
				if (graphRes.ok) {
					const snap = (await graphRes.json()) as GraphSnapshot;
					allNodes = snap.propositions ?? [];
				}
			} catch {
				// Proceed pickless if graph snapshot is unavailable.
			}
			const seeded = buildLabSeededRequest(data.gaps, targetKind, allNodes);
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
			if (bridge?.navigate) bridge.navigate(url);
			else window.location.assign(url);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not start follow-up session");
			setBusyKind(null);
		}
	};

	return (
		<div
			data-testid="lab-summary-card"
			className="my-2 rounded-xl border border-border bg-card/80 p-3.5 text-xs space-y-3"
		>
			<div className="space-y-1">
				<div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
					Lab Wrap-Up &amp; Gaps
				</div>
				<p className="text-sm leading-relaxed text-foreground">{data.summary}</p>
			</div>

			{data.milestonesCompleted.length > 0 && (
				<div className="space-y-1">
					<div className="text-[11px] font-medium text-muted-foreground">Completed milestones</div>
					<div className="flex flex-wrap gap-1.5">
						{data.milestonesCompleted.map((m, idx) => (
							<span
								key={idx}
								className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] text-success"
							>
								<CheckCircle2Icon className="size-3" />
								{m}
							</span>
						))}
					</div>
				</div>
			)}

			{data.gaps.length > 0 && (
				<div className="space-y-2">
					<div className="text-[11px] font-medium text-muted-foreground">Follow-up gaps</div>
					<ul className="space-y-1.5">
						{data.gaps.map((g, idx) => (
							<li key={idx} className="rounded-md border border-border/70 bg-background/60 px-2.5 py-2">
								<div className="flex items-center justify-between gap-2">
									<span className="font-medium text-foreground">{g.area}</span>
									{g.targets.length > 0 && (
										<span className="font-mono text-[10px] text-muted-foreground">
											{g.targets.length} {g.targets.length === 1 ? "node" : "nodes"}
										</span>
									)}
								</div>
								<p className="mt-0.5 text-xs text-muted-foreground">{g.note}</p>
							</li>
						))}
					</ul>

					{error && <p className="text-[11px] text-error">{error}</p>}

					<div className="flex flex-wrap items-center gap-2 pt-0.5">
						<button
							type="button"
							data-testid="lab-seed-teach"
							disabled={busyKind !== null}
							onClick={() => void startSeeded("teach")}
							className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
						>
							<CompassIcon className="size-3.5 text-muted-foreground" />
							{busyKind === "teach" ? "Starting…" : "Teach these"}
						</button>
						<button
							type="button"
							data-testid="lab-seed-practice"
							disabled={busyKind !== null}
							onClick={() => void startSeeded("practice")}
							className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
						>
							<DumbbellIcon className="size-3.5 text-muted-foreground" />
							{busyKind === "practice" ? "Starting…" : "Practice these"}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}
