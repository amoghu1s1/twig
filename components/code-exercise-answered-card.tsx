"use client";

import { useState } from "react";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { HighlightedCode } from "@/components/highlighted-code";
import { ThinkingBlock } from "@/components/thinking-block";
import { answeredCardExcerpt } from "@/components/answered-card";
import { useCardOpen } from "@/components/card-collapse-state";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { cn } from "@/lib/utils";
import { CODE_LANGUAGE_LABELS, restoreLiteralNewlines, type CodeExerciseAnswerData } from "@/src/core";

/**
 * Static record of a submitted code exercise (tool part in `output-available`):
 * the question, the code he submitted, what the last run did, and the
 * explanation tucked behind "Why" — the standing answered-card ruling
 * (components/answered-card.tsx). Graded exercises show the checks verdict;
 * run-only ones show the output without a verdict.
 */
export function CodeExerciseAnsweredCard({ answer, cardId }: { answer: CodeExerciseAnswerData; cardId?: string }) {
	const [whyOpen, setWhyOpen] = useState(false);
	const { open, store: collapseStore } = useCardOpen(cardId, true);
	const collapsible = Boolean(cardId && collapseStore);
	const { lastRun } = answer;
	const kindLabel = `Code · ${CODE_LANGUAGE_LABELS[answer.language]}`;

	if (collapsible && !open) {
		const excerpt = answeredCardExcerpt(restoreLiteralNewlines(answer.questionText));
		return (
			<button
				type="button"
				data-testid="answered-card-bar"
				data-answered-card={cardId}
				aria-expanded={false}
				aria-label={`Open ${kindLabel}: ${excerpt}`}
				onClick={(e) => {
					blurAfterPointerClick(e);
					collapseStore!.setOpen(cardId!, true);
				}}
				className="flex w-full min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-1.5 text-left font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<ChevronRightIcon className="size-3 shrink-0" />
				<span className="shrink-0 font-medium uppercase tracking-wide">{kindLabel}</span>
				{answer.dismissed ? (
					<span className="shrink-0 text-muted-foreground">skipped</span>
				) : (
					answer.graded && <Verdict passed={lastRun?.passed === true} timedOut={lastRun?.timedOut === true} />
				)}
				<span className="min-w-0 truncate text-foreground/80">{excerpt}</span>
			</button>
		);
	}

	if (answer.dismissed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground" data-answered-card={cardId}>
				{collapsible && (
					<button
						type="button"
						data-testid="answered-card-toggle"
						aria-expanded={true}
						aria-label={`Collapse ${kindLabel}`}
						onClick={(e) => {
							blurAfterPointerClick(e);
							collapseStore!.setOpen(cardId!, false);
						}}
						className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
					>
						<ChevronDownIcon className="size-3 shrink-0" />
						{kindLabel}
					</button>
				)}
				<span className="font-medium">{answer.questionText}</span> — skipped
			</div>
		);
	}
	return (
		<div className="rounded-xl border bg-card p-4 text-card-foreground" data-testid="code-answered-card" data-answered-card={cardId}>
			{collapsible ? (
				<button
					type="button"
					data-testid="answered-card-toggle"
					aria-expanded={true}
					aria-label={`Collapse ${kindLabel}`}
					onClick={(e) => {
						blurAfterPointerClick(e);
						collapseStore!.setOpen(cardId!, false);
					}}
					className="mb-1 flex w-full items-center gap-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground"
				>
					<ChevronDownIcon className="size-3 shrink-0" />
					{kindLabel}
					{answer.graded && <Verdict passed={lastRun?.passed === true} timedOut={lastRun?.timedOut === true} />}
				</button>
			) : (
				<div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
					{kindLabel}
					{answer.graded && <Verdict passed={lastRun?.passed === true} timedOut={lastRun?.timedOut === true} />}
				</div>
			)}
			<div className="mb-3 font-medium">
				<MessageResponse>{restoreLiteralNewlines(answer.questionText)}</MessageResponse>
			</div>
			<pre
				data-testid="code-answered-code"
				className="max-h-80 overflow-auto rounded-lg bg-muted/50 p-3 font-mono text-sm"
			>
				<HighlightedCode code={answer.code} language={answer.language} />
			</pre>
			{lastRun?.stdout && (
				<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 font-mono text-sm">
					{lastRun.stdout}
				</pre>
			)}
			{lastRun?.error && (
				<pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-destructive/40 p-3 font-mono text-sm text-destructive">
					{lastRun.error}
				</pre>
			)}
			{answer.thinking && (
				<ThinkingBlock testId="your-thinking" label="YOUR THINKING" text={answer.thinking} inCard />
			)}
			{answer.explanation && (
				<div className="mt-2" data-testid="tucked-explanation">
					<button
						type="button"
						onClick={() => setWhyOpen((v) => !v)}
						className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						{whyOpen ? "Hide why" : "Why"}
					</button>
					{whyOpen && (
						<div className="mt-1.5 rounded-lg bg-muted py-2 text-sm text-foreground/50">
							<span className="font-medium text-muted-foreground">Why: </span>
							<MessageResponse className="inline [&_p]:inline [&_p]:m-0">
								{restoreLiteralNewlines(answer.explanation)}
							</MessageResponse>
						</div>
					)}
				</div>
			)}
			{collapsible && (
				<div className="mt-2 flex items-center">
					<button
						type="button"
						data-testid="answered-card-collapse-bottom"
						aria-label={`Collapse ${kindLabel}`}
						title="Collapse"
						onClick={(e) => {
							blurAfterPointerClick(e);
							collapseStore!.setOpen(cardId!, false);
							window.requestAnimationFrame(() => {
								document.querySelector(`[data-answered-card="${CSS.escape(cardId!)}"]`)?.scrollIntoView({ block: "nearest" });
							});
						}}
						className="-ml-1 flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<ChevronUpIcon className="size-3.5" />
					</button>
				</div>
			)}
		</div>
	);
}

function Verdict({ passed, timedOut }: { passed: boolean; timedOut: boolean }) {
	return (
		<span
			data-testid="code-answered-verdict"
			className={cn("flex items-center gap-1 normal-case", passed ? "text-foreground" : "text-destructive")}
		>
			{passed ? <CheckIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
			{passed ? "Checks passed" : timedOut ? "Timed out" : "Checks failed"}
		</span>
	);
}
