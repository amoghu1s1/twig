"use client";

/**
 * DISCUSS ON A READING (docs/readings.md §14; owner rulings 2026-10-28).
 *
 * - PASSAGE THREADS: select text in a ready reading → "Ask about this" →
 *   a draft thread opens inline right after the block the selection ends
 *   in (blocks carry data-discuss-block keys — see ReadingBlocks). Each
 *   thread shows its quote, the exchanges, and a Reply box.
 * - THE SIDE CHAT ("Discuss"): one running conversation per reading, plus
 *   any passage thread whose block can't be found (the owner's fallback).
 *
 * Answers stream token by token (useLiveAnswer); the ask box carries the
 * source-mode toggle, defaulting to the reading's own mode. AI-only
 * answers carry the "not source-checked" label on their face; links the
 * run never fetched render unlinked with an "unverified" mark.
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { parseMarkdownIntoBlocks } from "streamdown";
import { MessageCircleQuestionIcon, SendIcon, SquareIcon } from "lucide-react";
import {
	exchangeIsLive,
	markUnverifiedLinks,
	placeThreads,
	subscriptionLabel,
	transformMathDelimiters,
	type ReadingMode,
} from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { planCostLabel } from "@/components/usage-format";
import {
	askQuestion,
	stopAnswer,
	useLiveAnswer,
	type DiscussionView,
	type ExchangeView,
	type ThreadView,
} from "@/components/readings/discussion-api";

// ─── blocks ─────────────────────────────────────────────────────────────────

/** A markdown string as its top-level blocks (the renderer's own split).
 *  Pure; exported for tests. */
export function markdownBlocks(markdown: string): string[] {
	return parseMarkdownIntoBlocks(transformMathDelimiters(markdown)).filter((b) => b.trim().length > 0);
}

// ─── the seam the reading view provides ─────────────────────────────────────

/** A passage the learner picked but hasn't asked about yet. */
export interface DiscussDraft {
	passage: string;
	/** The block it renders after; undefined → drafted in the side chat. */
	blockKey?: string;
}

interface DiscussSeam {
	readingId: string;
	readingMode: ReadingMode;
	discussion: DiscussionView | null;
	/** Block key → the passage threads shown after it. */
	inline: Map<string, ThreadView[]>;
	draft: DiscussDraft | null;
	setDraft: (d: DiscussDraft | null) => void;
	/** The draft's block isn't rendered → the side chat takes it. */
	draftInSide: boolean;
	/** Ask from the selection action (tray: switches to the side chat when
	 *  the draft lands there). */
	onDraftInSide?: () => void;
}

const DiscussContext = createContext<DiscussSeam | null>(null);

/** Provides the discussion to the blocks, the inline threads, the
 *  selection action and the side chat of ONE reading. */
export function DiscussProvider({
	readingId,
	readingMode,
	discussion,
	renderedBlocks,
	onDraftInSide,
	children,
}: {
	readingId: string;
	readingMode: ReadingMode;
	discussion: DiscussionView | null;
	renderedBlocks: ReadonlySet<string>;
	onDraftInSide?: () => void;
	children: ReactNode;
}) {
	const [draft, setDraft] = useState<DiscussDraft | null>(null);
	const inline = useMemo(() => placeThreads(discussion?.threads ?? [], renderedBlocks).inline, [discussion, renderedBlocks]);
	const draftInSide = draft !== null && !(draft.blockKey && renderedBlocks.has(draft.blockKey));
	const seam = useMemo(
		() => ({ readingId, readingMode, discussion, inline, draft, setDraft, draftInSide, onDraftInSide }),
		[readingId, readingMode, discussion, inline, draft, draftInSide, onDraftInSide],
	);
	return <DiscussContext.Provider value={seam}>{children}</DiscussContext.Provider>;
}

function useDiscuss(): DiscussSeam | null {
	return useContext(DiscussContext);
}

/** One markdown field rendered block by block, each block tagged with its
 *  key and followed by the passage threads (and the draft) placed there. */
export function ReadingBlocks({ markdown, keyPrefix, className }: { markdown: string; keyPrefix: string; className?: string }) {
	const blocks = useMemo(() => markdownBlocks(markdown), [markdown]);
	return (
		<div className={`flex flex-col gap-4 ${className ?? ""}`}>
			{blocks.map((block, i) => {
				const key = `${keyPrefix}:${i}`;
				return (
					<div key={key}>
						<div data-discuss-block={key}>
							<MessageResponse>{block}</MessageResponse>
						</div>
						<InlineThreads blockKey={key} />
					</div>
				);
			})}
		</div>
	);
}

/** The block keys a markdown field renders (ReadingBlocks' keys). */
export function blockKeys(markdown: string | undefined, keyPrefix: string): string[] {
	return markdown ? markdownBlocks(markdown).map((_, i) => `${keyPrefix}:${i}`) : [];
}

/** The passage threads + draft placed after one block. */
export function InlineThreads({ blockKey }: { blockKey: string }) {
	const seam = useDiscuss();
	if (!seam) return null;
	const threads = seam.inline.get(blockKey) ?? [];
	const drafting = seam.draft?.blockKey === blockKey && !seam.draftInSide;
	if (threads.length === 0 && !drafting) return null;
	return (
		<div className="my-3 flex flex-col gap-3">
			{threads.map((t) => (
				<ThreadCard key={t.id} thread={t} readingId={seam.readingId} readingMode={seam.readingMode} />
			))}
			{drafting && seam.draft && <DraftCard draft={seam.draft} />}
		</div>
	);
}

// ─── one exchange / one thread ──────────────────────────────────────────────

function ExchangeItem({ readingId, exchange: x }: { readingId: string; exchange: ExchangeView }) {
	const live = exchangeIsLive(x);
	const stream = useLiveAnswer(readingId, x.id, live);
	const answer = live ? (stream?.text ?? "") : x.answer ? markUnverifiedLinks(x.answer, x.unverifiedUrls ?? []) : "";
	const activity = stream?.activity || x.activity || (x.status === "queued" ? "queued" : "answering");
	return (
		<div data-testid="discuss-exchange" data-status={x.status} className="flex flex-col gap-1.5">
			<div className="self-end whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent px-3 py-1.5 text-sm">{x.question}</div>
			{answer && (
				<div className="text-sm">
					<MessageResponse>{answer}</MessageResponse>
				</div>
			)}
			{live && (
				<div className="flex items-center gap-2 font-ui text-xs text-muted-foreground">
					<BrailleSpinner label="Answering" />
					<span className="min-w-0 flex-1 truncate" title={activity}>
						{x.status === "queued" ? "Queued…" : activity}
					</span>
					<button
						type="button"
						data-testid="discuss-stop"
						onClick={() => void stopAnswer(x.id)}
						className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-destructive/10 hover:text-destructive"
					>
						<SquareIcon className="size-3" /> Stop
					</button>
				</div>
			)}
			{x.status === "error" && (
				<div data-testid="discuss-error" className="font-ui text-xs text-destructive">
					{x.error === "Stopped" ? "Stopped before it was finished." : `Couldn't answer: ${x.error ?? "unknown error"}`}
				</div>
			)}
			{x.status === "done" && x.sources && x.sources.length > 0 && (
				<ol className="list-decimal pl-5 font-ui text-xs text-muted-foreground">
					{x.sources.map((s) => (
						<li key={s.url}>
							<a href={s.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
								{s.title}
							</a>
						</li>
					))}
				</ol>
			)}
			{!live && (
				<div className="flex flex-wrap items-center gap-x-2 font-ui text-[0.7rem] text-muted-foreground/80">
					{x.mode === "model" ? (
						<span className="text-amber-600 dark:text-amber-400/90" title="Answered from model knowledge — no sources were read">
							AI only · not source-checked
						</span>
					) : (
						<span>Researched</span>
					)}
					{x.usage && <span className="tabular-nums">· {planCostLabel(x.costUsd, subscriptionLabel(x.usage.model))}</span>}
				</div>
			)}
		</div>
	);
}

function Quote({ text }: { text: string }) {
	return <blockquote className="border-l-2 border-primary/50 pl-2.5 text-sm text-muted-foreground line-clamp-4">{text}</blockquote>;
}

/** A passage thread: its quote, the exchanges, and a Reply box. */
function ThreadCard({ thread, readingId, readingMode, showQuote = true }: { thread: ThreadView; readingId: string; readingMode: ReadingMode; showQuote?: boolean }) {
	const [replying, setReplying] = useState(false);
	const busy = thread.exchanges.some(exchangeIsLive);
	return (
		<div data-testid="discuss-thread" className="flex flex-col gap-3 rounded-lg border border-border/70 bg-card/40 px-3 py-2.5 font-normal not-italic">
			{showQuote && thread.passage && <Quote text={thread.passage} />}
			{thread.exchanges.map((x) => (
				<ExchangeItem key={x.id} readingId={readingId} exchange={x} />
			))}
			{replying ? (
				<AskBox
					readingId={readingId}
					initialMode={readingMode}
					busy={busy}
					placeholder="Follow up…"
					autoFocus
					ask={(question, mode) => ({ question, mode, threadId: thread.id })}
					onAsked={() => setReplying(false)}
					onCancel={() => setReplying(false)}
				/>
			) : (
				!busy && (
					<button
						type="button"
						data-testid="discuss-reply"
						onClick={() => setReplying(true)}
						className="self-start rounded-full px-2 py-0.5 font-ui text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						Reply
					</button>
				)
			)}
		</div>
	);
}

/** The picked passage, waiting for its first question. */
function DraftCard({ draft }: { draft: DiscussDraft }) {
	const seam = useDiscuss();
	if (!seam) return null;
	return (
		<div data-testid="discuss-draft" className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-card/40 px-3 py-2.5">
			<Quote text={draft.passage} />
			<AskBox
				readingId={seam.readingId}
				initialMode={seam.readingMode}
				busy={false}
				placeholder="Ask about this passage…"
				autoFocus
				ask={(question, mode) => ({ question, mode, passage: draft.passage, ...(draft.blockKey ? { blockKey: draft.blockKey } : {}) })}
				onAsked={() => seam.setDraft(null)}
				onCancel={() => seam.setDraft(null)}
			/>
		</div>
	);
}

// ─── the ask box ────────────────────────────────────────────────────────────

const MODE_OPTIONS = [
	["researched", "Researched", "Web research; only fetched pages are listed as sources"],
	["model", "AI only", "Faster and cheaper — answered from model knowledge, not source-checked"],
] as const;

function AskBox({
	readingId,
	initialMode,
	busy,
	placeholder,
	autoFocus,
	ask,
	onAsked,
	onCancel,
}: {
	readingId: string;
	initialMode: ReadingMode;
	/** The thread is answering: no new question until it settles. */
	busy: boolean;
	placeholder: string;
	autoFocus?: boolean;
	ask: (question: string, mode: ReadingMode) => Parameters<typeof askQuestion>[1];
	onAsked?: () => void;
	onCancel?: () => void;
}) {
	const [text, setText] = useState("");
	const [mode, setMode] = useState<ReadingMode>(initialMode);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const ref = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (autoFocus) ref.current?.focus();
	}, [autoFocus]);
	const disabled = busy || sending;
	const submit = async () => {
		const question = text.trim();
		if (!question || disabled) return;
		setSending(true);
		setError(null);
		const res = await askQuestion(readingId, ask(question, mode));
		setSending(false);
		if (!res.ok) return setError(res.error);
		setText("");
		onAsked?.();
	};
	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-end gap-1.5 rounded-xl border border-border/80 bg-background px-2 py-1.5 focus-within:border-primary/60">
				<textarea
					ref={ref}
					data-testid="discuss-input"
					rows={1}
					value={text}
					disabled={disabled}
					placeholder={busy ? "Answering…" : placeholder}
					onChange={(e) => setText(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
							e.preventDefault();
							void submit();
						} else if (e.key === "Escape" && onCancel) {
							e.preventDefault();
							onCancel();
						}
					}}
					className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-sm outline-none [field-sizing:content] placeholder:text-muted-foreground disabled:opacity-60"
				/>
				<button
					type="button"
					aria-label="Ask"
					data-testid="discuss-send"
					disabled={disabled || !text.trim()}
					onClick={() => void submit()}
					className="rounded-full p-1.5 text-primary transition-colors hover:bg-accent disabled:opacity-40"
				>
					{sending ? <BrailleSpinner label="Sending" /> : <SendIcon className="size-3.5" />}
				</button>
			</div>
			<div className="flex items-center gap-2">
				<div role="radiogroup" aria-label="Source mode" className="inline-flex rounded-full border border-border/80 p-0.5 font-ui text-[0.7rem]">
					{MODE_OPTIONS.map(([m, label, title]) => (
						<button
							key={m}
							type="button"
							role="radio"
							aria-checked={mode === m}
							title={title}
							data-testid={`discuss-mode-${m}`}
							onClick={() => setMode(m)}
							className={`rounded-full px-2 py-0.5 transition-colors ${mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
						>
							{label}
						</button>
					))}
				</div>
				{onCancel && (
					<button type="button" onClick={onCancel} className="ml-auto rounded-full px-2 py-0.5 font-ui text-xs text-muted-foreground hover:bg-accent">
						Cancel
					</button>
				)}
			</div>
			{error && <div className="font-ui text-xs text-destructive">{error}</div>}
		</div>
	);
}

// ─── the side chat ──────────────────────────────────────────────────────────

/** The Discuss side chat: passage threads that couldn't be placed, the
 *  running conversation, and its ask box. */
export function DiscussPanel({ renderedBlocks }: { renderedBlocks: ReadonlySet<string> }) {
	const seam = useDiscuss();
	const endRef = useRef<HTMLDivElement>(null);
	const d = seam?.discussion ?? null;
	const sideCount = d?.side.exchanges.length ?? 0;
	useEffect(() => {
		endRef.current?.scrollIntoView({ block: "nearest" });
	}, [sideCount]);
	if (!seam) return null;
	if (!d) {
		return (
			<div className="flex items-center gap-2 p-2 font-ui text-xs text-muted-foreground">
				<BrailleSpinner label="Loading" /> Loading…
			</div>
		);
	}
	const fallback = placeThreads(d.threads, renderedBlocks).fallback;
	const busy = d.side.exchanges.some(exchangeIsLive);
	return (
		<div data-testid="discuss-panel" className="flex flex-col gap-4">
			{fallback.length === 0 && sideCount === 0 && !seam.draftInSide && (
				<p className="font-ui text-xs text-muted-foreground">
					Ask anything about this reading. To ask about one passage, select it in the reading.
				</p>
			)}
			{fallback.map((t) => (
				<ThreadCard key={t.id} thread={t} readingId={seam.readingId} readingMode={seam.readingMode} />
			))}
			{seam.draftInSide && seam.draft && <DraftCard draft={seam.draft} />}
			{d.side.exchanges.map((x) => (
				<ExchangeItem key={x.id} readingId={seam.readingId} exchange={x} />
			))}
			<div ref={endRef} />
			<AskBox
				readingId={seam.readingId}
				initialMode={seam.readingMode}
				busy={busy}
				placeholder="Ask about this reading…"
				ask={(question, mode) => ({ question, mode })}
			/>
		</div>
	);
}

// ─── "Ask about this" on a selection ────────────────────────────────────────

const MIN_CHARS = 3;
const MAX_CHARS = 4000;

/** The passage a selection maps to inside the reading's content root, or
 *  null. The block is the one the selection ENDS in (undefined when it
 *  ends outside every block → the side chat). Exported for tests. */
export function discussPassageFromSelection(sel: Selection | null, root: HTMLElement | null): { text: string; blockKey?: string; rect: DOMRect } | null {
	if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) return null;
	const text = sel.toString().replace(/\s+/g, " ").trim();
	if (text.length < MIN_CHARS) return null;
	const range = sel.getRangeAt(0);
	const el = (n: Node | null) => (n instanceof Element ? n : (n?.parentElement ?? null));
	const start = el(range.startContainer);
	const end = el(range.endContainer);
	if (!start || !end || !root.contains(start) || !root.contains(end)) return null;
	// Never from inside a thread (questions about answers are follow-ups).
	if (start.closest('[data-testid="discuss-thread"], [data-testid="discuss-draft"]') || end.closest('[data-testid="discuss-thread"], [data-testid="discuss-draft"]')) return null;
	const blockKey = end.closest<HTMLElement>("[data-discuss-block]")?.dataset.discussBlock;
	return { text: text.slice(0, MAX_CHARS), ...(blockKey ? { blockKey } : {}), rect: range.getBoundingClientRect() };
}

export function PassageAsk({ rootRef }: { rootRef: RefObject<HTMLElement | null> }) {
	const seam = useDiscuss();
	const [pick, setPick] = useState<{ text: string; blockKey?: string; x: number; y: number } | null>(null);
	useEffect(() => {
		if (!seam) return;
		const update = () => {
			const found = discussPassageFromSelection(document.getSelection(), rootRef.current);
			if (!found) return setPick(null);
			setPick({
				text: found.text,
				...(found.blockKey ? { blockKey: found.blockKey } : {}),
				x: Math.min(Math.max(found.rect.left + found.rect.width / 2, 80), window.innerWidth - 80),
				y: Math.max(found.rect.top - 8, 56),
			});
		};
		const onUp = () => setTimeout(update, 0);
		const onSelection = () => {
			if (document.getSelection()?.isCollapsed) setPick(null);
		};
		const onScroll = () => setPick(null);
		document.addEventListener("mouseup", onUp);
		document.addEventListener("keyup", onUp);
		document.addEventListener("selectionchange", onSelection);
		document.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("mouseup", onUp);
			document.removeEventListener("keyup", onUp);
			document.removeEventListener("selectionchange", onSelection);
			document.removeEventListener("scroll", onScroll, true);
		};
	}, [seam, rootRef]);
	if (!seam || !pick) return null;
	return (
		<div
			data-testid="discuss-passage-ask"
			className="fixed z-50 -translate-x-1/2 -translate-y-full"
			style={{ left: pick.x, top: pick.y }}
			// Keep the selection alive while clicking the action.
			onMouseDown={(e) => e.preventDefault()}
		>
			<div className="flex items-center gap-1 rounded-full border bg-card px-1 py-1 shadow-lg">
				<button
					type="button"
					onClick={() => {
						const draft = { passage: pick.text, ...(pick.blockKey ? { blockKey: pick.blockKey } : {}) };
						seam.setDraft(draft);
						document.getSelection()?.removeAllRanges();
						setPick(null);
						if (!pick.blockKey) seam.onDraftInSide?.();
					}}
					className="flex items-center gap-1.5 rounded-full px-2.5 py-1 font-ui text-xs font-medium hover:bg-accent"
				>
					<MessageCircleQuestionIcon className="size-3.5 text-primary" />
					Ask about this
				</button>
			</div>
		</div>
	);
}
