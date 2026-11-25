"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ListTreeIcon, SearchIcon, XIcon } from "lucide-react";
import {
	derivedNodeStatus,
	derivePlanStatuses,
	textPartMessageId,
	type ChatHighlight,
	type CodeExerciseAnswerData,
	type LhViewMessage,
	type PlanNodeStatus,
	type PlanTree,
	type QuestionAnswerData,
} from "@/src/core";
import { answeredCardExcerpt, answeredCardKindLabel } from "@/components/answered-card";
import { HIGHLIGHT_SWATCH_CSS } from "@/components/highlights";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";

export interface SessionHeadingItem {
	id: string;
	level: number;
	text: string;
	messageId: string;
	/** Zero-based index among headings inside this message's rendered DOM. */
	indexInMessage: number;
}

export interface SessionQuestionItem {
	cardId: string;
	kindLabel: string;
	excerpt: string;
	badge?: string;
}

function cleanHeadingText(raw: string): string {
	return raw
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/[*_`~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** Extract markdown headings from tutor prose parts (ignoring fenced code blocks). */
export function extractSessionHeadings(messages: readonly LhViewMessage[]): SessionHeadingItem[] {
	const headings: SessionHeadingItem[] = [];
	const perMessageCount = new Map<string, number>();

	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const part of m.parts) {
			if (part.type !== "text" || typeof part.text !== "string" || !part.text.trim()) continue;
			const messageId = textPartMessageId(part.id) ?? m.id;
			if (!messageId) continue;
			const lines = part.text.split(/\r?\n/);
			let fence: string | null = null;
			for (const line of lines) {
				const fenceMatch = line.match(/^\s*(```+|~~~+)/);
				if (fenceMatch) {
					const marker = fenceMatch[1]![0]!;
					if (!fence) fence = marker;
					else if (fence === marker) fence = null;
					continue;
				}
				if (fence) continue;
				const match = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
				if (!match) continue;
				const text = cleanHeadingText(match[2]!);
				if (!text) continue;
				const idx = perMessageCount.get(messageId) ?? 0;
				perMessageCount.set(messageId, idx + 1);
				headings.push({
					id: `${messageId}#h${idx}`,
					level: match[1]!.length,
					text,
					messageId,
					indexInMessage: idx,
				});
			}
		}
	}
	return headings;
}

/** Extract answered Question / Check / Prediction / Explain / Code cards. */
export function extractSessionQuestions(messages: readonly LhViewMessage[]): SessionQuestionItem[] {
	const items: SessionQuestionItem[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const part of m.parts) {
			if (part.state !== "output-available" || !part.toolCallId) continue;
			if (
				part.type === "tool-quiz" ||
				part.type === "tool-probe" ||
				part.type === "tool-ask_user_question" ||
				part.type === "tool-explain" ||
				part.type === "tool-recall"
			) {
				const answer = part.output as QuestionAnswerData | undefined;
				if (!answer) continue;
				let badge: string | undefined;
				if (answer.dismissed) badge = "skipped";
				else if (answer.kind === "quiz") {
					badge = answer.dontKnow ? "didn't know" : answer.correct ? "correct" : "incorrect";
				}
				items.push({
					cardId: part.toolCallId,
					kindLabel: answeredCardKindLabel(answer),
					excerpt: answeredCardExcerpt(answer.questionText, 72),
					...(badge ? { badge } : {}),
				});
			} else if (part.type === "tool-code-exercises") {
				const answer = part.output as CodeExerciseAnswerData | undefined;
				if (!answer) continue;
				let badge: string | undefined;
				if (answer.dismissed) badge = "skipped";
				else if (answer.graded) badge = answer.lastRun?.passed ? "passed" : "failed";
				items.push({
					cardId: part.toolCallId,
					kindLabel: "Code",
					excerpt: answeredCardExcerpt(answer.questionText, 72),
					...(badge ? { badge } : {}),
				});
			}
		}
	}
	return items;
}

export function SessionOutlineChip({
	messages,
	planTree,
	planJumpTargets,
	highlights,
	onJumpMessage,
	onJumpHeading,
	onJumpCard,
	onJumpHighlight,
}: {
	messages: readonly LhViewMessage[];
	planTree: PlanTree | null;
	planJumpTargets: ReadonlyMap<string, string>;
	highlights: readonly ChatHighlight[];
	onJumpMessage: (messageId: string) => void;
	onJumpHeading: (heading: SessionHeadingItem) => void;
	onJumpCard: (cardId: string) => void;
	onJumpHighlight: (highlight: ChatHighlight) => void;
}) {
	const [open, setOpen] = useState(false);
	const [filter, setFilter] = useState("");
	const containerRef = useRef<HTMLDivElement>(null);
	const filterRef = useRef<HTMLInputElement>(null);

	const headings = useMemo(() => extractSessionHeadings(messages), [messages]);
	const questions = useMemo(() => extractSessionQuestions(messages), [messages]);
	const statuses = useMemo(
		() => (planTree ? derivePlanStatuses(planTree, messages) : null),
		[planTree, messages],
	);

	useEffect(() => {
		if (!open) return;
		filterRef.current?.focus({ preventScroll: true });
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				setOpen(false);
			}
		};
		const onPointerDown = (e: PointerEvent) => {
			if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("keydown", onKey, true);
		document.addEventListener("pointerdown", onPointerDown);
		return () => {
			document.removeEventListener("keydown", onKey, true);
			document.removeEventListener("pointerdown", onPointerDown);
		};
	}, [open]);

	const needle = filter.trim().toLowerCase();
	const match = (s: string) => !needle || s.toLowerCase().includes(needle);

	const nodes = useMemo(() => {
		if (!planTree) return [];
		return planTree.nodes
			.map((n) => ({
				...n,
				status: (statuses ? derivedNodeStatus(statuses, n.id) : "upcoming") as PlanNodeStatus,
				targetMessageId: planJumpTargets.get(n.id),
			}))
			.filter((n) => match(n.title));
	}, [planTree, statuses, planJumpTargets, needle]);

	const filteredHeadings = useMemo(() => headings.filter((h) => match(h.text)), [headings, needle]);
	const filteredQuestions = useMemo(
		() => questions.filter((q) => match(q.excerpt) || match(q.kindLabel)),
		[questions, needle],
	);
	const filteredHighlights = useMemo(
		() => highlights.filter((h) => match(h.selector.text)),
		[highlights, needle],
	);

	const totalItems = nodes.length + filteredHeadings.length + filteredQuestions.length + filteredHighlights.length;

	return (
		<div ref={containerRef} className="relative flex shrink-0 items-center">
			<Hint label={open ? "Close outline" : "Session outline & jump list"} side="bottom">
				<button
					type="button"
					data-testid="session-outline-chip"
					aria-expanded={open}
					onClick={(e) => {
						blurAfterPointerClick(e);
						setOpen((v) => !v);
					}}
					className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
				>
					<ListTreeIcon className="size-3.5 text-primary" aria-hidden />
					Outline
				</button>
			</Hint>
			{open && (
				<div
					role="dialog"
					aria-label="Session outline"
					data-testid="session-outline-popover"
					className="lh-no-drag absolute right-0 top-full z-50 mt-2 flex max-h-[70vh] w-80 flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl"
				>
					<div className="flex items-center gap-2 border-b px-3 py-2">
						<SearchIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
						<input
							ref={filterRef}
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							placeholder="Filter strands, headings, questions…"
							aria-label="Filter session outline"
							className="lh-input min-w-0 flex-1 bg-transparent font-ui text-xs outline-none placeholder:text-muted-foreground"
						/>
						{filter && (
							<button
								type="button"
								aria-label="Clear outline filter"
								onClick={() => setFilter("")}
								className="rounded p-0.5 text-muted-foreground hover:text-foreground"
							>
								<XIcon className="size-3" />
							</button>
						)}
					</div>
					<div className="flex flex-col gap-3 overflow-y-auto p-2.5 font-ui text-xs">
						{totalItems === 0 && (
							<p className="py-4 text-center text-muted-foreground">
								{needle ? "No matching outline items." : "Nothing in this session yet."}
							</p>
						)}
						{nodes.length > 0 && (
							<section>
								<div className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Strands
								</div>
								<div className="flex flex-col gap-0.5">
									{nodes.map((n) => (
										<button
											key={n.id}
											type="button"
											disabled={!n.targetMessageId}
											onClick={() => {
												if (!n.targetMessageId) return;
												onJumpMessage(n.targetMessageId);
												setOpen(false);
											}}
											className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
										>
											<span
												className={cn(
													"size-2 shrink-0 rounded-full",
													n.status === "current"
														? "bg-warning"
														: n.status === "visited"
															? "bg-primary"
															: "border border-muted-foreground/50",
												)}
											/>
											<span className="min-w-0 flex-1 truncate">{n.title}</span>
										</button>
									))}
								</div>
							</section>
						)}
						{filteredHeadings.length > 0 && (
							<section>
								<div className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Headings
								</div>
								<div className="flex flex-col gap-0.5">
									{filteredHeadings.map((h) => (
										<button
											key={h.id}
											type="button"
											onClick={() => {
												onJumpHeading(h);
												setOpen(false);
											}}
											style={{ paddingLeft: `${6 + Math.max(0, h.level - 2) * 10}px` }}
											className="truncate rounded-md py-1 pr-1.5 text-left text-foreground/90 transition-colors hover:bg-accent"
										>
											{h.text}
										</button>
									))}
								</div>
							</section>
						)}
						{filteredQuestions.length > 0 && (
							<section>
								<div className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Questions
								</div>
								<div className="flex flex-col gap-0.5">
									{filteredQuestions.map((q) => (
										<button
											key={q.cardId}
											type="button"
											onClick={() => {
												onJumpCard(q.cardId);
												setOpen(false);
											}}
											className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent"
										>
											<span className="shrink-0 text-[10px] font-medium uppercase text-muted-foreground">
												{q.kindLabel}
											</span>
											<span className="min-w-0 flex-1 truncate">{q.excerpt}</span>
											{q.badge && (
												<span className="shrink-0 text-[10px] text-muted-foreground">{q.badge}</span>
											)}
										</button>
									))}
								</div>
							</section>
						)}
						{filteredHighlights.length > 0 && (
							<section>
								<div className="mb-1 px-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
									Highlights
								</div>
								<div className="flex flex-col gap-0.5">
									{filteredHighlights.map((h) => (
										<button
											key={h.id}
											type="button"
											onClick={() => {
												onJumpHighlight(h);
												setOpen(false);
											}}
											className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent"
										>
											<span
												className="size-2 shrink-0 rounded-full"
												style={{ backgroundColor: HIGHLIGHT_SWATCH_CSS[h.color].dot }}
											/>
											<span className="min-w-0 flex-1 truncate">“{h.selector.text}”</span>
										</button>
									))}
								</div>
							</section>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
