"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { SvgImage } from "@/components/artifacts/svg-image";
import { HighlightedCode } from "@/components/highlighted-code";
import { StatusBadge } from "@/components/ui/status-badge";
import { ThinkingBlock } from "@/components/thinking-block";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { INTERACTION_LAYER_Z_BASE } from "@/components/host-dialog";
import { useInteractionLayers } from "@/components/interaction-layers";
import {
	CODE_LANGUAGE_LABELS,
	parsePracticeCheckInput,
	parsePracticeCodeInput,
	parsePracticeMatchInput,
	type ArtifactPartProps,
	type PracticeStructuredSubmitDetails,
	type PracticeThinkingAction,
} from "@/src/core";

/**
 * Practice v2 transcript cards:
 * - ProblemCard / PracticeCheckCard / PracticeMatchCard / PracticeCodeCard — posed
 *   statements & visible prompts ONLY (commitments like modelSolution, correctAnswer,
 *   and correctMapping NEVER render here).
 * - ConcludeCard — outcome badge + verdict + verbatim committed modelSolution reveal
 *   (dismissed and voided render as quiet single-line notices).
 * - ThinkingCard / PracticeStructuredSubmitCard — learner's own submissions & actions.
 */

let nodeNameMapPromise: Promise<Record<string, string>> | null = null;
export function nodeNameMap(): Promise<Record<string, string>> {
	nodeNameMapPromise ??= fetch("/api/graph")
		.then((r) => (r.ok ? r.json() : { nodes: [] }))
		.then((g: { nodes?: Array<{ id?: unknown; name?: unknown }> }) =>
			Object.fromEntries(
				(g.nodes ?? [])
					.filter((n) => typeof n.id === "string")
					.map((n) => [n.id as string, typeof n.name === "string" ? (n.name as string) : (n.id as string)]),
			),
		)
		.catch(() => ({}));
	return nodeNameMapPromise;
}

export interface PracticeThinkingData {
	problemCallId: string;
	commit?: boolean;
	action?: PracticeThinkingAction;
	text: string;
	images?: readonly Readonly<import("@earendil-works/pi-ai").ImageContent>[];
}

export function ProblemCard({ part }: ArtifactPartProps) {
	const input = (part.input ?? {}) as { statement?: string };
	const statement = typeof input.statement === "string" ? input.statement : "";
	return (
		<div data-testid="problem-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Problem</div>
			<div className="lh-prose text-[15px]">
				<ToolContentResponse>{statement}</ToolContentResponse>
			</div>
		</div>
	);
}

export function PracticeCheckCard({ part }: ArtifactPartProps) {
	const parsed = parsePracticeCheckInput(part.input);
	if (!parsed) {
		const fallback = typeof (part.input as { statement?: unknown } | undefined)?.statement === "string"
			? (part.input as { statement: string }).statement
			: "";
		return (
			<div data-testid="practice-check-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Quick check</div>
				<div className="lh-prose text-[15px]">
					<ToolContentResponse>{fallback}</ToolContentResponse>
				</div>
			</div>
		);
	}
	return (
		<div data-testid="practice-check-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Quick check{parsed.multiSelect ? " · Multi-select" : ""}
			</div>
			<div className="lh-prose text-[15px]">
				<ToolContentResponse>{parsed.statement}</ToolContentResponse>
			</div>
			{parsed.svg && (
				<div className="my-2">
					<SvgImage svg={parsed.svg} />
				</div>
			)}
			<ul className="mt-2.5 space-y-1 text-xs text-muted-foreground">
				{parsed.options.map((opt, idx) => (
					<li key={idx} className="rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5">
						<ToolContentResponse>{opt.label}</ToolContentResponse>
					</li>
				))}
			</ul>
		</div>
	);
}

export function PracticeMatchCard({ part }: ArtifactPartProps) {
	const parsed = parsePracticeMatchInput(part.input);
	if (!parsed) {
		const fallback = typeof (part.input as { statement?: unknown } | undefined)?.statement === "string"
			? (part.input as { statement: string }).statement
			: "";
		return (
			<div data-testid="practice-match-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
				<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Classify &amp; Match</div>
				<div className="lh-prose text-[15px]">
					<ToolContentResponse>{fallback}</ToolContentResponse>
				</div>
			</div>
		);
	}
	return (
		<div data-testid="practice-match-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Classify &amp; Match</div>
			<div className="lh-prose text-[15px]">
				<ToolContentResponse>{parsed.statement}</ToolContentResponse>
			</div>
			<div className="mt-2.5 flex flex-wrap gap-1.5">
				{parsed.categories.map((cat) => (
					<span key={cat.id} className="rounded-full border border-border/70 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
						{cat.label}
					</span>
				))}
			</div>
			<ul className="mt-2 space-y-1 text-xs text-muted-foreground">
				{parsed.items.map((item) => (
					<li key={item.id} className="rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5">
						<ToolContentResponse>{item.prompt}</ToolContentResponse>
					</li>
				))}
			</ul>
		</div>
	);
}

export function PracticeCodeCard({ part }: ArtifactPartProps) {
	const parsed = parsePracticeCodeInput(part.input);
	const raw = (part.input ?? {}) as { statement?: string; language?: string; starterCode?: string };
	const statement = parsed?.statement ?? (typeof raw.statement === "string" ? raw.statement : "");
	const language = parsed?.language ?? "python";
	const starterCode = parsed?.starterCode ?? (typeof raw.starterCode === "string" ? raw.starterCode : "");
	return (
		<div data-testid="practice-code-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4">
			<div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Code · {CODE_LANGUAGE_LABELS[language]}
			</div>
			<div className="lh-prose text-[15px]">
				<ToolContentResponse>{statement}</ToolContentResponse>
			</div>
			{starterCode.trim().length > 0 && (
				<pre className="mt-2.5 overflow-x-auto rounded-lg border border-border/60 bg-background/60 p-2.5 font-mono text-xs">
					<HighlightedCode code={starterCode} language={language} />
				</pre>
			)}
		</div>
	);
}

const OUTCOME_LABEL: Record<string, string> = {
	solved: "Solved",
	solvedWithHints: "Solved with hints",
	movedOn: "Moved on",
	surrendered: "Surrendered",
	dismissed: "Dismissed",
	voided: "Voided",
};

const OUTCOME_COLOR: Record<string, string | undefined> = {
	solved: "var(--lh-success)",
	solvedWithHints: "var(--lh-warning)",
	surrendered: "var(--lh-error)",
};

export function ConcludeCard({ part }: ArtifactPartProps) {
	const input = (part.input ?? {}) as { outcome?: string; verdict?: string; solutionReveal?: string };
	const outcome = typeof input.outcome === "string" ? input.outcome : "";
	const verdict = typeof input.verdict === "string" ? input.verdict : "";
	const reveal =
		typeof part.reveal === "string" ? part.reveal : typeof input.solutionReveal === "string" ? input.solutionReveal : "";

	if (outcome === "dismissed") {
		return (
			<div data-testid="conclude-card" className="my-1 px-1 text-sm text-muted-foreground/70">
				Problem dismissed.
			</div>
		);
	}

	if (outcome === "voided") {
		return (
			<div data-testid="conclude-card" className="my-1 px-1 text-sm text-muted-foreground/70">
				Problem replaced.
			</div>
		);
	}

	return (
		<div data-testid="conclude-card" className="lh-card-enter relative my-1 rounded-xl border bg-card p-4">
			<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				Concluded
				{(OUTCOME_LABEL[outcome] ?? "") !== "" && (
					<StatusBadge text={OUTCOME_LABEL[outcome] ?? ""} color={OUTCOME_COLOR[outcome]} />
				)}
			</div>
			{verdict.length > 0 && (
				<div className="text-sm text-foreground/50">
					<ToolContentResponse>{verdict}</ToolContentResponse>
				</div>
			)}
			{reveal.length > 0 && (
				<>
					<div className="my-3 border-t" />
					<div>
						<div className="mb-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Model solution</div>
						<div className="lh-prose text-[15px]">
							<ToolContentResponse>{reveal}</ToolContentResponse>
						</div>
					</div>
				</>
			)}
			<MetadataPopover
				concludeInput={input}
				problemInput={(part.problemInput ?? {}) as { mode?: unknown; target?: unknown }}
			/>
		</div>
	);
}

function MetadataPopover({
	concludeInput,
	problemInput,
}: {
	concludeInput: { outcome?: string; rung?: unknown; missClass?: unknown; retest?: unknown };
	problemInput: { mode?: unknown; target?: unknown };
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const interactions = useInteractionLayers();
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const [names, setNames] = useState<Record<string, string> | null>(null);
	const targets = Array.isArray(problemInput.target)
		? problemInput.target.filter((t): t is string => typeof t === "string")
		: [];
	useEffect(() => {
		if (!open || targets.length === 0 || names) return;
		let alive = true;
		void nodeNameMap().then((m) => {
			if (alive) setNames(m);
		});
		return () => {
			alive = false;
		};
	}, [open, targets.length, names]);

	const popupLayer = usePopoverDismiss(rootRef, open, () => setOpen(false), { layerRootRef: panelRef });
	useEffect(() => {
		if (!open) return;
		const close = () => {
			if (interactions.isElementEligible(panelRef.current)) setOpen(false);
		};
		window.addEventListener("scroll", close, { capture: true, passive: true });
		return () => window.removeEventListener("scroll", close, { capture: true });
	}, [open, interactions]);

	const mode = typeof problemInput.mode === "string" ? problemInput.mode : "";
	const rung = typeof concludeInput.rung === "string" ? concludeInput.rung : "";
	const miss = typeof concludeInput.missClass === "string" ? concludeInput.missClass : "";
	const retest = typeof concludeInput.retest === "boolean" ? concludeInput.retest : undefined;
	const outcome = typeof concludeInput.outcome === "string" ? concludeInput.outcome : "";
	if (!mode && targets.length === 0 && !rung && !miss && retest === undefined) return null;

	return (
		<div ref={rootRef} className="relative mt-3">
			<button
				type="button"
				data-testid="metadata-toggle"
				ref={triggerRef}
				onClick={() => {
					setOpen((v) => {
						if (v) return false;
						const r = triggerRef.current?.getBoundingClientRect();
						if (r) {
							const left = Math.max(8, Math.min(r.left, window.innerWidth - 328));
							setAnchor({ top: r.bottom + 8, left });
						}
						return true;
					});
				}}
				aria-expanded={open}
				className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
			>
				Metadata
			</button>
			{open &&
				anchor &&
				createPortal(
					<div
						ref={panelRef}
						data-testid="metadata-box"
						style={{
							position: "fixed",
							top: anchor.top,
							left: anchor.left,
							zIndex: INTERACTION_LAYER_Z_BASE + popupLayer.order,
						}}
						className="w-80 max-w-[calc(100vw-1rem)] rounded-xl border bg-card p-4 text-left shadow-lg"
					>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
							<dt className="text-muted-foreground">Mode</dt>
							<dd className="font-mono">{mode || "—"}</dd>
							<dt className="text-muted-foreground">Targets</dt>
							<dd className="font-mono">
								{targets.length === 0 ? (
									"untagged"
								) : (
									<span>
										{targets.map((t, i) => (
											<span key={t}>
												{i > 0 && ", "}
												{names?.[t] ?? t}
											</span>
										))}
									</span>
								)}
							</dd>
							<dt className="text-muted-foreground">Outcome</dt>
							<dd className="font-mono">{outcome || "—"}</dd>
							<dt className="text-muted-foreground">Hint rung</dt>
							<dd className="font-mono">{rung || "none"}</dd>
							<dt className="text-muted-foreground">Miss class</dt>
							<dd className="font-mono">{miss || "none"}</dd>
							<dt className="text-muted-foreground">Retest</dt>
							<dd className="font-mono">{retest === undefined ? "—" : retest ? "yes" : "no"}</dd>
						</dl>
					</div>,
					interactions.getPortalContainer(triggerRef.current)!,
				)}
		</div>
	);
}

const ACTION_LABELS: Partial<Record<PracticeThinkingAction, string>> = {
	hint: "HINT REQUESTED",
	"show-solution": "SHOW SOLUTION",
	"step-down": "REQUESTED EASIER STEP",
	"flag-bad": "FLAGGED BAD QUESTION",
};

export function ThinkingCard({ data }: { data: PracticeThinkingData }) {
	const actionLabel = data.action && data.action !== "submit" ? ACTION_LABELS[data.action] : undefined;
	if (actionLabel && !data.text.trim() && !(data.images && data.images.length > 0)) {
		return (
			<div
				data-testid="thinking-card"
				className="my-1 flex items-center gap-2 border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-card px-[14px] py-1.5 font-ui text-xs uppercase tracking-wide text-muted-foreground"
			>
				<span>{actionLabel}</span>
			</div>
		);
	}
	return (
		<ThinkingBlock
			testId="thinking-card"
			label={actionLabel ? `YOUR THINKING · ${actionLabel}` : "YOUR THINKING"}
			text={data.text}
			images={data.images}
			defaultOpen
		/>
	);
}

export function PracticeStructuredSubmitCard({ data }: { data: PracticeStructuredSubmitDetails }) {
	return (
		<div
			data-testid="practice-structured-submit-card"
			className="my-2 w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-card py-2 pl-[14px] pr-4 text-xs"
		>
			<div className="mb-1 flex items-center gap-2 font-ui font-medium uppercase tracking-wide text-muted-foreground">
				<span>Your answer</span>
				<StatusBadge
					text={data.passed ? "Passed" : "Missed"}
					color={data.passed ? "var(--lh-success)" : "var(--lh-error)"}
				/>
			</div>
			<div className="whitespace-pre-wrap text-sm text-foreground">{data.summaryText}</div>
			{data.thinking?.trim() && (
				<div className="mt-1.5 text-muted-foreground italic">{data.thinking.trim()}</div>
			)}
		</div>
	);
}
