"use client";

/**
 * ONE READING, RENDERED (docs/readings.md §8) — shared by the session's
 * tray (compact) and the full page /readings/[id]. Status-aware: a reading
 * being written shows its live activity line and a Stop control; a failed
 * one says why and offers a re-run; a ready one renders the document —
 * body, glossary or overview sections (each tagged with its plan nodes,
 * live status + Read deeper), sources, further reading — with the actions: Practice
 * this (the existing practice entry), Re-run (either source mode),
 * Download (.md), Delete.
 *
 * The doctrine fence is visible in the chrome: AI-only readings carry the
 * "not source-checked" label on their face.
 *
 * DISCUSS (docs/readings.md §14): a ready reading renders block by block
 * (passage threads sit after their block) and carries the Discuss side
 * chat — a column beside it on the full page, a toggled view in the tray.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import {
	ArrowLeftIcon,
	BookOpenIcon,
	DownloadIcon,
	DumbbellIcon,
	ExternalLinkIcon,
	MessagesSquareIcon,
	RotateCcwIcon,
	SquareIcon,
	Trash2Icon,
} from "lucide-react";
import {
	discussionMarkdown,
	READING_KIND_LABEL,
	readingMarkdown,
	subscriptionLabel,
	type OverviewSection,
	type PlanNodeStatus,
	type ReadingMode,
} from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { planCostLabel } from "@/components/usage-format";
import {
	ago,
	deleteReadingRequest,
	requestReading,
	startPractice,
	stopReading,
	useReading,
	useReadingMode,
	useSessionReadings,
	type FullReading,
} from "@/components/readings/api";
import { useDiscussion } from "@/components/readings/discussion-api";
import { blockKeys, DiscussPanel, DiscussProvider, PassageAsk, ReadingBlocks } from "@/components/readings/discussion";

export function ModeToggle({
	mode,
	onChange,
	size = "sm",
}: {
	mode: ReadingMode;
	onChange: (m: ReadingMode) => void;
	size?: "sm" | "xs";
}) {
	const pad = size === "xs" ? "px-2 py-0.5" : "px-2.5 py-1";
	return (
		<div role="radiogroup" aria-label="Source mode" className="inline-flex rounded-full border border-border/80 p-0.5 font-ui text-xs">
			{(
				[
					["researched", "Researched", "Web research with verified citations"],
					["model", "AI only", "Faster and cheaper — written from model knowledge, not source-checked"],
				] as const
			).map(([m, label, title]) => (
				<button
					key={m}
					type="button"
					role="radio"
					aria-checked={mode === m}
					title={title}
					data-testid={`reading-mode-${m}`}
					onClick={() => onChange(m)}
					className={`rounded-full ${pad} transition-colors ${mode === m ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
				>
					{label}
				</button>
			))}
		</div>
	);
}

export function ModeLabel({ mode }: { mode: ReadingMode }) {
	return mode === "researched" ? (
		<span className="text-muted-foreground">Researched</span>
	) : (
		<span className="text-amber-600 dark:text-amber-400/90" title="Written from model knowledge — no sources were read">
			AI only · not source-checked
		</span>
	);
}

/** The view, by id (fetches + follows live updates). */
export function ReadingView({
	id,
	compact = false,
	onDeleted,
	onOpenReading,
}: {
	id: string;
	compact?: boolean;
	onDeleted?: () => void;
	/** A re-run opens the new version (tray: in place; page: navigate). */
	onOpenReading?: (id: string) => void;
}) {
	const reading = useReading(id);
	if (reading === null) {
		return (
			<div className="flex items-center gap-2 p-4 font-ui text-xs text-muted-foreground">
				<BrailleSpinner label="Loading" /> Loading…
			</div>
		);
	}
	if (reading === "error") {
		return <div className="p-4 text-sm text-muted-foreground">Couldn’t load this reading — the app server didn’t answer. It will retry on the next update.</div>;
	}
	if (reading === "missing") {
		return <div className="p-4 text-sm text-muted-foreground">This reading no longer exists.</div>;
	}
	return <ReadingDocument reading={reading} compact={compact} onDeleted={onDeleted} onOpenReading={onOpenReading} />;
}

export function ReadingDocument({
	reading: r,
	compact,
	onDeleted,
	onOpenReading,
}: {
	reading: FullReading;
	compact?: boolean;
	onDeleted?: () => void;
	onOpenReading?: (id: string) => void;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState<null | "practice" | "rerun" | "delete">(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [rerunMode, setRerunMode] = useState<ReadingMode>(r.mode);
	const live = r.status === "queued" || r.status === "writing";
	const ready = r.status === "ready";

	// Discuss: the discussion, the block keys this reading renders (where
	// passage threads can sit), and — in the tray — the toggled view.
	const discussion = useDiscussion(ready ? r.id : null);
	const renderedBlocks = useMemo(
		() =>
			new Set(
				ready
					? [
							...blockKeys(r.body, "body"),
							...(r.sections ?? []).flatMap((sec, i) => blockKeys(sec.body, `sec:${i}`)),
							...(r.terms ?? []).flatMap((t, i) => blockKeys(t.definition, `term:${i}`)),
						]
					: [],
			),
		[ready, r.body, r.sections, r.terms],
	);
	const [discussOpen, setDiscussOpen] = useState(false);
	const articleRef = useRef<HTMLElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	const readingScroll = useRef(0);
	// The tray swaps views inside one scroll container: remember where the
	// reading was, and land back there.
	const showDiscuss = (open: boolean) => {
		const scroller = scrollParent(articleRef.current);
		if (open) {
			readingScroll.current = scroller?.scrollTop ?? 0;
			setDiscussOpen(true);
			requestAnimationFrame(() => scroller?.scrollTo({ top: 0 }));
		} else {
			setDiscussOpen(false);
			requestAnimationFrame(() => scroller?.scrollTo({ top: readingScroll.current }));
		}
	};
	const tray = compact === true;

	const rerun = async () => {
		setBusy("rerun");
		setError(null);
		const res = await requestReading({ kind: r.kind, rerunOf: r.id, mode: rerunMode });
		setBusy(null);
		if (!res.ok) return setError(res.error);
		if (onOpenReading) onOpenReading(res.id);
		else router.push(`/readings/${res.id}`);
	};
	const practice = async () => {
		setBusy("practice");
		const target = await startPractice(r.title, r.practice);
		setBusy(null);
		if (target) router.push(target);
		else setError("Couldn't start a practice session");
	};
	const remove = async () => {
		setBusy("delete");
		const ok = await deleteReadingRequest(r.id);
		setBusy(null);
		if (ok) onDeleted?.();
		else setError("Couldn't delete the reading");
	};

	const askedCount = discussion ? discussion.side.exchanges.length + discussion.threads.reduce((n, t) => n + t.exchanges.length, 0) : 0;

	const article = (
		<article
			ref={articleRef}
			data-testid="reading-view"
			data-status={r.status}
			hidden={tray && discussOpen}
			className={compact ? "flex flex-col gap-4 px-4 pb-6" : "flex min-w-0 flex-col gap-5"}
		>
			<header className="flex flex-col gap-1.5">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-ui text-xs">
					<span className="flex items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 uppercase tracking-wide text-muted-foreground">
						<BookOpenIcon className="size-3" aria-hidden />
						{READING_KIND_LABEL[r.kind]}
					</span>
					<ModeLabel mode={r.mode} />
					<span className="text-muted-foreground/70">· {ago(r.createdAt)}</span>
					{r.usage && <span className="tabular-nums text-muted-foreground/70">· {planCostLabel(r.costUsd, subscriptionLabel(r.usage.model))}</span>}
					{tray && ready && (
						<button
							type="button"
							data-testid="reading-discuss"
							onClick={() => showDiscuss(true)}
							className="ml-auto flex items-center gap-1 rounded-full border border-border/80 px-2 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						>
							<MessagesSquareIcon className="size-3" aria-hidden /> Discuss
							{askedCount > 0 && <span className="tabular-nums">· {askedCount}</span>}
						</button>
					)}
				</div>
				<h1 className={compact ? "text-lg font-semibold leading-snug" : "font-title text-3xl tracking-tight"}>{r.title}</h1>
				{!compact && r.anchor.chatId && r.chatTitle && (
					<Link href={`/chat/${r.anchor.chatId}`} className="font-ui text-xs text-muted-foreground hover:text-foreground">
						From the session “{r.chatTitle}” →
					</Link>
				)}
				{r.anchor.passage && (
					<blockquote className="mt-1 border-l-2 border-border pl-3 text-sm text-muted-foreground">{r.anchor.passage}</blockquote>
				)}
				{r.request && <p className="font-ui text-xs text-muted-foreground">Your request: {r.request}</p>}
			</header>

			{live && (
				<div data-testid="reading-live" className="flex items-center gap-2 rounded-lg border border-border/70 bg-card/60 px-3 py-2 font-ui text-xs text-muted-foreground">
					<BrailleSpinner label="Writing" />
					<span className="min-w-0 flex-1 truncate" title={r.activity}>
						{r.status === "queued" ? "Queued…" : r.activity || "Writing…"}
					</span>
					<button
						type="button"
						onClick={() => void stopReading(r.id)}
						className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-destructive/10 hover:text-destructive"
					>
						<SquareIcon className="size-3" /> Stop
					</button>
				</div>
			)}

			{r.status === "error" && (
				<div data-testid="reading-error" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
					{r.error === "Stopped" ? "Stopped before it was finished." : `Couldn't write this reading: ${r.error ?? "unknown error"}`}
				</div>
			)}

			{r.status === "ready" && (
				<div ref={contentRef} className={compact ? "flex flex-col gap-4" : "flex flex-col gap-5"}>
					{r.body && <ReadingBlocks markdown={r.body} keyPrefix="body" className="text-[0.95rem]" />}
					{r.sections && r.sections.length > 0 && (
						<div data-testid="reading-sections" className="flex flex-col gap-6">
							{r.sections.map((sec, i) => (
								<OverviewSectionView key={`${i}:${sec.heading}`} section={sec} index={i} reading={r} />
							))}
						</div>
					)}
					{r.terms && r.terms.length > 0 && (
						<dl data-testid="reading-terms" className="flex flex-col gap-3">
							{r.terms.map((t, i) => (
								<div key={t.term} className="rounded-lg border border-border/60 px-3 py-2">
									<dt className="font-semibold">
										<MessageResponse>{t.term}</MessageResponse>
									</dt>
									<dd className="mt-0.5 text-sm text-muted-foreground">
										<ReadingBlocks markdown={t.definition} keyPrefix={`term:${i}`} />
									</dd>
								</div>
							))}
						</dl>
					)}
					{r.furtherReading && r.furtherReading.length > 0 && (
						<section data-testid="reading-further" className="flex flex-col gap-2">
							<h2 className="font-ui text-xs uppercase tracking-widest text-muted-foreground">Further reading</h2>
							<ul className="flex flex-col gap-2">
								{r.furtherReading.map((f) => (
									<li key={f.url} className="text-sm">
										<a href={f.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 font-medium hover:underline">
											{f.title}
											<ExternalLinkIcon className="size-3 text-muted-foreground" aria-hidden />
										</a>
										{f.level && <span className="ml-1.5 font-ui text-[0.7rem] uppercase text-muted-foreground">{f.level}</span>}
										<div className="text-muted-foreground">{f.why}</div>
									</li>
								))}
							</ul>
						</section>
					)}
					{r.sources && r.sources.length > 0 && (
						<section data-testid="reading-sources" className="flex flex-col gap-1.5">
							<h2 className="font-ui text-xs uppercase tracking-widest text-muted-foreground">Sources</h2>
							<ol className="list-decimal pl-5 text-sm">
								{r.sources.map((s) => (
									<li key={s.url}>
										<a href={s.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
											{s.title}
										</a>
									</li>
								))}
							</ol>
						</section>
					)}
				</div>
			)}

			{error && <div className="font-ui text-xs text-destructive">{error}</div>}

			<footer className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 font-ui text-xs">
				{r.status === "ready" && r.practice.length > 0 && (
					<button
						type="button"
						data-testid="reading-practice"
						disabled={busy !== null}
						onClick={() => void practice()}
						title={`Practice the ${r.practice.length} proposition${r.practice.length === 1 ? "" : "s"} this reading covers`}
						className="flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-60"
					>
						<DumbbellIcon className="size-3.5" /> Practice this
					</button>
				)}
				{r.status === "ready" && (
					<button
						type="button"
						onClick={() =>
							downloadFile(`${slugFilename(r.title)}.md`, [readingMarkdown(r), discussionMarkdown(discussion)].filter(Boolean).join("\n"), "text/markdown")
						}
						className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						<DownloadIcon className="size-3.5" /> Download
					</button>
				)}
				{!live && (
					<span className="flex items-center gap-1.5">
						<button
							type="button"
							data-testid="reading-rerun"
							disabled={busy !== null}
							onClick={() => void rerun()}
							className="flex items-center gap-1 rounded-full px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
						>
							<RotateCcwIcon className="size-3.5" /> {r.kind === "recap" ? "Update" : "Re-run"}
						</button>
						<ModeToggle mode={rerunMode} onChange={setRerunMode} size="xs" />
					</span>
				)}
				<span className="ml-auto flex items-center gap-1.5">
					{confirmDelete ? (
						<>
							<span className="text-muted-foreground">Delete permanently?</span>
							<button type="button" onClick={() => setConfirmDelete(false)} className="rounded-full px-2 py-1 hover:bg-accent">
								Cancel
							</button>
							<button
								type="button"
								data-testid="reading-delete-confirm"
								disabled={busy !== null}
								onClick={() => void remove()}
								className="rounded-full border border-destructive/50 bg-destructive/10 px-2.5 py-1 text-destructive hover:bg-destructive/20"
							>
								Delete
							</button>
						</>
					) : (
						<button
							type="button"
							aria-label="Delete reading"
							data-testid="reading-delete"
							onClick={() => setConfirmDelete(true)}
							className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
						>
							<Trash2Icon className="size-3.5" />
						</button>
					)}
				</span>
			</footer>
		</article>
	);

	return (
		<DiscussProvider
			readingId={r.id}
			readingMode={r.mode}
			discussion={discussion}
			renderedBlocks={renderedBlocks}
			onDraftInSide={tray ? () => showDiscuss(true) : undefined}
		>
			{tray ? (
				<>
					{article}
					{discussOpen && (
						<div data-testid="discuss-view" className="flex flex-col gap-4 px-4 pb-6">
							<div className="flex items-center gap-2 font-ui text-xs">
								<button
									type="button"
									data-testid="discuss-back"
									onClick={() => showDiscuss(false)}
									className="flex items-center gap-1 rounded-md px-1.5 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
								>
									<ArrowLeftIcon className="size-3.5" /> Reading
								</button>
								<span className="flex items-center gap-1.5 uppercase tracking-widest text-muted-foreground">
									<MessagesSquareIcon className="size-3.5" /> Discuss
								</span>
							</div>
							<h2 className="text-base font-semibold leading-snug">{r.title}</h2>
							<DiscussPanel renderedBlocks={renderedBlocks} />
						</div>
					)}
				</>
			) : ready ? (
				<div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-10">
					{article}
					<aside
						data-testid="discuss-column"
						aria-label="Discuss"
						className="mt-10 flex flex-col gap-3 self-start border-t border-border/60 pt-6 lg:sticky lg:top-0 lg:mt-0 lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto lg:border-l lg:border-t-0 lg:pl-6 lg:pt-0"
					>
						<h2 className="flex items-center gap-1.5 font-ui text-xs uppercase tracking-widest text-muted-foreground">
							<MessagesSquareIcon className="size-3.5" /> Discuss
						</h2>
						<DiscussPanel renderedBlocks={renderedBlocks} />
					</aside>
				</div>
			) : (
				<div className="mx-auto w-full max-w-3xl">{article}</div>
			)}
			{ready && <PassageAsk rootRef={contentRef} />}
		</DiscussProvider>
	);
}

/** The nearest scrolling ancestor (the tray's or the page's scroller). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
	for (let cur = el?.parentElement ?? null; cur; cur = cur.parentElement) {
		const overflow = getComputedStyle(cur).overflowY;
		if (overflow === "auto" || overflow === "scroll") return cur;
	}
	return null;
}

const STATUS_LABEL: Record<PlanNodeStatus, string> = { visited: "Visited", current: "Current", upcoming: "Upcoming" };
const STATUS_CLASS: Record<PlanNodeStatus, string> = {
	visited: "text-muted-foreground",
	current: "text-primary",
	upcoming: "text-muted-foreground/70",
};

/** One overview section: heading, its plan-node chips, then the prose. */
function OverviewSectionView({ section, index, reading: r }: { section: OverviewSection; index: number; reading: FullReading }) {
	const titles = new Map((r.snapshot.planNodes ?? []).map((n) => [n.id, n.title] as const));
	const ids = section.planNodeIds ?? [];
	return (
		<section data-testid="reading-section" className="flex flex-col gap-2">
			<h2 className="text-lg font-semibold leading-snug">{section.heading}</h2>
			{ids.length > 0 && (
				<div className="flex flex-wrap gap-1.5">
					{ids.map((id) => (
						<NodeChip key={id} nodeId={id} title={titles.get(id) ?? id} status={r.planStatus?.[id]} chatId={r.anchor.chatId} />
					))}
				</div>
			)}
			<ReadingBlocks markdown={section.body} keyPrefix={`sec:${index}`} className="text-[0.95rem]" />
		</section>
	);
}

/** A plan node a section maps to: its live status in the lesson and a
 *  Read deeper action (a deep dive on that node). A node no longer in
 *  the plan (no status) shows its title only — a deep dive needs it. */
function NodeChip({ nodeId, title, status, chatId }: { nodeId: string; title: string; status?: PlanNodeStatus; chatId?: string }) {
	const router = useRouter();
	const seam = useSessionReadings();
	const [mode] = useReadingMode();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const readDeeper = async () => {
		setBusy(true);
		setError(null);
		if (seam && seam.chatId === chatId) {
			// In the session's tray: the seam opens the new reading in place.
			const err = await seam.request({ kind: "deep-dive", planNodeId: nodeId });
			setBusy(false);
			if (err) setError(err);
			return;
		}
		const res = await requestReading({ kind: "deep-dive", chatId, planNodeId: nodeId, mode });
		setBusy(false);
		if (!res.ok) return setError(res.error);
		router.push(`/readings/${res.id}`);
	};
	return (
		<span
			data-testid="reading-node-chip"
			data-status={status ?? "gone"}
			title={error ?? undefined}
			className="inline-flex items-center gap-1.5 rounded-full border border-border/80 py-0.5 pl-2.5 pr-1 font-ui text-xs"
		>
			<span className="text-foreground">{title}</span>
			{status && <span className={STATUS_CLASS[status]}>· {STATUS_LABEL[status]}</span>}
			{status && chatId ? (
				<button
					type="button"
					data-testid="reading-node-deeper"
					disabled={busy}
					onClick={() => void readDeeper()}
					className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 ${error ? "text-destructive" : "text-muted-foreground"}`}
				>
					{busy ? <BrailleSpinner label="Starting" /> : <BookOpenIcon className="size-3" aria-hidden />}
					Read deeper
				</button>
			) : (
				<span className="pr-1.5" />
			)}
		</span>
	);
}
