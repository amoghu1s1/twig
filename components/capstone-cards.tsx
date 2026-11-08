"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { DumbbellIcon, GraduationCapIcon, HammerIcon } from "lucide-react";

import { ToolContentResponse } from "@/components/ai-elements/message";
import { ToolCallCard } from "@/components/artifacts/tool-call-card";
import { nodeNameMap } from "@/components/practice-cards";
import { SessionStarter } from "@/components/start-session";
import { cn } from "@/lib/utils";
import {
	parseBriefInput,
	parseEvaluateInput,
	parseGapReportInput,
	parseReviewInput,
	seededSessionBody,
	type ArtifactPartProps,
	type CapstoneGapView,
	type CapstoneVerdictView,
	type SeedNode,
} from "@/src/core";

/**
 * The capstone transcript cards (capstone sessions, 2026-11-01): the
 * accepted brief, checkpoint reviews, evaluations and the gap report.
 * Every card reads its model-authored input only through the core parse
 * seam (src/core/capstone-parts.ts) and renders nothing for an input that
 * fails it. A call that errored (a refused brief/review/evaluate) falls
 * back to the quiet expandable tool-call card — it never reads as an
 * accepted brief or a recorded verdict.
 */

/** How the seeded-start buttons navigate. Chat provides the app router's
 *  push (a client-side transition); the default is a plain page load, so the
 *  cards render anywhere (render tests, previews) without a mounted router. */
export const SeedNavigationContext = createContext<(path: string) => void>((path) => {
	window.location.assign(path);
});

const EYEBROW = "mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground";

const STATUS_LABEL: Record<CapstoneVerdictView["status"], string> = { met: "Met", partial: "Partial", unmet: "Unmet" };
/* The practice outcome chips' register: success = the "correct" twin,
 * warning = succeeded with cost, error = it beat the learner. Theme tokens
 * only (the status-color law) — the active theme owns the hues. */
const STATUS_CHIP: Record<CapstoneVerdictView["status"], string> = {
	met: "bg-success/15 text-success",
	partial: "bg-warning/15 text-warning",
	unmet: "bg-error/15 text-error",
};

const failedPart = (part: ArtifactPartProps["part"]): boolean =>
	part.state === "output-error" || typeof (part as { errorText?: unknown }).errorText === "string";

/** Proposition ids → names, lazily and cached; failures degrade to ids. */
function useNodeNames(): Record<string, string> {
	const [names, setNames] = useState<Record<string, string>>({});
	useEffect(() => {
		let live = true;
		void nodeNameMap().then((m) => {
			if (live) setNames(m);
		});
		return () => {
			live = false;
		};
	}, []);
	return names;
}

function TargetChips({ targets, names }: { targets: readonly string[]; names: Record<string, string> }) {
	if (targets.length === 0) return null;
	return (
		<div className="mt-1 flex flex-wrap gap-1">
			{targets.map((t) => (
				<span key={t} className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
					{names[t] ?? t}
				</span>
			))}
		</div>
	);
}

// ─── brief ───────────────────────────────────────────────────────────────────

export function BriefCard({ part }: ArtifactPartProps) {
	const names = useNodeNames();
	if (failedPart(part)) return <ToolCallCard part={part} />;
	const brief = parseBriefInput(part.input);
	if (!brief) return null;
	return (
		<div data-testid="brief-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className={EYEBROW}>Brief</div>
			<div className="font-prose text-[17px] leading-snug">{brief.title}</div>
			<div className="mt-0.5 break-all font-mono text-xs text-muted-foreground" data-testid="brief-directory">
				{brief.directory}
			</div>
			<ol className="mt-3 space-y-2">
				{brief.criteria.map((c) => (
					<li key={c.id} data-testid="brief-criterion" className="text-[15px]">
						<span className="mr-2 font-mono text-xs text-muted-foreground">{c.id}</span>
						<span className="lh-prose">{c.text}</span>
						<TargetChips targets={c.targets ?? []} names={names} />
					</li>
				))}
			</ol>
		</div>
	);
}

// ─── verdict rows (review + evaluate) ────────────────────────────────────────

function VerdictRows({ verdicts }: { verdicts: readonly CapstoneVerdictView[] }) {
	return (
		<ul className="space-y-3">
			{verdicts.map((v) => (
				<li key={v.criterion} data-testid="verdict-row" data-status={v.status}>
					<div className="flex items-center gap-2">
						<span className="font-mono text-xs text-muted-foreground">{v.criterion}</span>
						<span className={cn("rounded px-1.5 py-0.5 text-xs font-medium", STATUS_CHIP[v.status])}>{STATUS_LABEL[v.status]}</span>
					</div>
					<div className="mt-1 text-sm text-foreground/60">
						<ToolContentResponse>{v.evidence}</ToolContentResponse>
					</div>
				</li>
			))}
		</ul>
	);
}

export function ReviewCard({ part }: ArtifactPartProps) {
	if (failedPart(part)) return <ToolCallCard part={part} />;
	const review = parseReviewInput(part.input);
	if (!review) return null;
	return (
		<div data-testid="review-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className={EYEBROW}>Checkpoint review</div>
			<div className="lh-prose mb-3 text-[15px]">
				<ToolContentResponse>{review.summary}</ToolContentResponse>
			</div>
			<VerdictRows verdicts={review.verdicts} />
		</div>
	);
}

// ─── gaps + seeded start ─────────────────────────────────────────────────────

function GapList({ gaps, names }: { gaps: readonly CapstoneGapView[]; names: Record<string, string> }) {
	return (
		<ul className="space-y-2">
			{gaps.map((g, i) => (
				<li key={`${g.area}-${i}`} data-testid="gap-row">
					<div className="text-[15px] font-medium">{g.area}</div>
					<div className="text-sm text-foreground/60">{g.note}</div>
					<TargetChips targets={g.targets} names={names} />
				</li>
			))}
		</ul>
	);
}

/** "Teach these" / "Practice these": create a session seeded from the gaps
 *  (graphContext = the gaps' tagged propositions; title + auto-sent first
 *  message = "Revisit: …") and navigate to it. A failure stays on the card. */
function SeedButtons({ gaps }: { gaps: readonly CapstoneGapView[] }) {
	const navigate = useContext(SeedNavigationContext);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const start = async (as: "teach" | "practice") => {
		if (busy) return;
		setBusy(true);
		setFailed(false);
		try {
			// Fresh graph read at click time: the card carries only ids.
			const res = await fetch("/api/graph");
			const snap = res.ok ? ((await res.json()) as { propositions?: SeedNode[] }) : {};
			const nodes = Array.isArray(snap.propositions) ? snap.propositions : [];
			const target = await new SessionStarter().start(seededSessionBody(as, gaps, nodes), fetch);
			navigate(target);
		} catch {
			setBusy(false);
			setFailed(true);
		}
	};
	const button =
		"flex cursor-pointer items-center gap-1.5 rounded-full border bg-card px-3 py-1.5 font-ui text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-50";
	return (
		<div className="mt-3 border-t pt-3">
			<div className="flex flex-wrap items-center gap-2">
				<button type="button" data-testid="seed-teach" disabled={busy} onClick={() => void start("teach")} className={button}>
					<GraduationCapIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
					Teach these
				</button>
				<button type="button" data-testid="seed-practice" disabled={busy} onClick={() => void start("practice")} className={button}>
					<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
					Practice these
				</button>
			</div>
			{failed && (
				<p role="alert" data-testid="seed-error" className="mt-2 text-sm text-destructive">
					Couldn’t start the session. Try again.
				</p>
			)}
		</div>
	);
}

// ─── evaluate ────────────────────────────────────────────────────────────────

export function EvaluateCard({ part }: ArtifactPartProps) {
	const names = useNodeNames();
	if (failedPart(part)) return <ToolCallCard part={part} />;
	const evaluation = parseEvaluateInput(part.input);
	if (!evaluation) return null;
	return (
		<div data-testid="evaluate-card" data-latest={part.latest === true} className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className={EYEBROW}>
				<HammerIcon aria-hidden="true" className="size-3" />
				Evaluation
				{part.latest === true && <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">Latest</span>}
			</div>
			<VerdictRows verdicts={evaluation.verdicts} />
			<div className="my-3 border-t" />
			<div>
				<div className={EYEBROW}>Observations</div>
				<div className="lh-prose text-[15px]">
					<ToolContentResponse>{evaluation.observations}</ToolContentResponse>
				</div>
			</div>
			{evaluation.gaps.length > 0 && (
				<>
					<div className="my-3 border-t" />
					<div>
						<div className={EYEBROW}>Gaps</div>
						<GapList gaps={evaluation.gaps} names={names} />
						<SeedButtons gaps={evaluation.gaps} />
					</div>
				</>
			)}
		</div>
	);
}

// ─── gap_report (the no-pitch path) ──────────────────────────────────────────

export function GapReportCard({ part }: ArtifactPartProps) {
	const names = useNodeNames();
	if (failedPart(part)) return <ToolCallCard part={part} />;
	const report = parseGapReportInput(part.input);
	if (!report) return null;
	return (
		<div data-testid="gap-report-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className={EYEBROW}>Gap report</div>
			<div className="lh-prose mb-3 text-[15px]">
				<ToolContentResponse>{report.summary}</ToolContentResponse>
			</div>
			<GapList gaps={report.gaps} names={names} />
			{report.gaps.length > 0 && <SeedButtons gaps={report.gaps} />}
		</div>
	);
}
