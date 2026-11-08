"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDownIcon, ChevronRightIcon, TrashIcon } from "lucide-react";
import {
	ERROR_TYPES,
	ERROR_TYPE_LABELS,
	filterMistakes,
	groupMistakes,
	summarizeMistakes,
	type ErrorType,
	type MistakeGroupBy,
	type MistakeKind,
	type MistakeRecord,
} from "@/src/core";
import { ToolContentResponse } from "@/components/ai-elements/message";
import { SidebarToggle } from "@/components/sidebar";
import { useServerEvent } from "@/components/server-events";
import { cn } from "@/lib/utils";

/**
 * The Mistakes tab (mistakes fork, 2026-11-08 — ported from
 * vvcdev/learnharness): every miss from every session, with its short error
 * analysis, for fast review before an exam. Group by error type,
 * session/source, or topic; filter; expand everything at once.
 */

interface Progress {
	active: number;
	done: number;
	total: number;
}

const KIND_LABEL: Record<MistakeKind, string> = { missed: "Missed", unanswered: "Unanswered", problem: "Problem" };
const GROUPS: { by: MistakeGroupBy; label: string }[] = [
	{ by: "type", label: "Error type" },
	{ by: "session", label: "Session / source" },
	{ by: "topic", label: "Topic" },
];

export function MistakesPage() {
	const [records, setRecords] = useState<MistakeRecord[] | null>(null);
	const [progress, setProgress] = useState<Progress>({ active: 0, done: 0, total: 0 });
	const [by, setBy] = useState<MistakeGroupBy>("type");
	const [query, setQuery] = useState("");
	const [errorType, setErrorType] = useState<ErrorType | "">("");
	const [kind, setKind] = useState<MistakeKind | "">("");
	const [chatId, setChatId] = useState("");
	const [open, setOpen] = useState<Set<string>>(new Set()); // expanded cards
	const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
	const [scanNote, setScanNote] = useState<{ found: number; retry: number } | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/mistakes", { cache: "no-store" });
			if (!res.ok) return;
			const body = (await res.json()) as { mistakes: MistakeRecord[]; progress: Progress };
			setRecords(body.mistakes);
			setProgress(body.progress);
		} catch {
			setRecords((prev) => prev ?? []);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	useServerEvent("mistakes-changed", () => void load());

	const filtered = useMemo(() => filterMistakes(records ?? [], { query, errorType, kind, chatId }), [records, query, errorType, kind, chatId]);
	const groups = useMemo(() => groupMistakes(filtered, by), [filtered, by]);
	const summary = useMemo(() => summarizeMistakes(records ?? []), [records]);
	const sessions = useMemo(() => {
		const seen = new Map<string, string>();
		for (const r of records ?? []) seen.set(r.chatId, r.sessionTitle || "Untitled session");
		return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
	}, [records]);

	const toggle = (id: string) =>
		setOpen((prev) => {
			const next = new Set(prev);
			if (!next.delete(id)) next.add(id);
			return next;
		});
	const toggleGroup = (key: string) =>
		setClosedGroups((prev) => {
			const next = new Set(prev);
			if (!next.delete(key)) next.add(key);
			return next;
		});

	const remove = async (id: string) => {
		setRecords((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
		await fetch(`/api/mistakes/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
	};
	const retry = async (id: string) => {
		setRecords((prev) => (prev ? prev.map((r) => (r.id === id ? { ...r, status: "pending", error: undefined } : r)) : prev));
		await fetch(`/api/mistakes/${encodeURIComponent(id)}/retry`, { method: "POST" }).catch(() => {});
	};
	const scan = async (confirm: boolean) => {
		setBusy(true);
		try {
			const res = await fetch("/api/mistakes/scan", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ confirm }),
			});
			const body = (await res.json()) as { found?: number; retry?: number };
			if (confirm) {
				setScanNote(null);
				await load();
			} else if ((body.found ?? 0) === 0 && (body.retry ?? 0) === 0) {
				setScanNote({ found: 0, retry: 0 });
			} else {
				setScanNote({ found: body.found ?? 0, retry: body.retry ?? 0 });
			}
		} finally {
			setBusy(false);
		}
	};

	const analyzing = progress.active > 0;

	return (
		<div className="relative flex h-dvh flex-col" data-testid="mistakes-page">
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />
			<header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-3 py-2">
				<div className="pointer-events-auto">
					<SidebarToggle />
				</div>
			</header>

			<div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-4 px-4 pb-8 pt-14 sm:px-6">
				<div className="flex flex-wrap items-end justify-between gap-3">
					<div>
						<h1 className="font-title text-2xl tracking-tight text-foreground">Mistakes</h1>
						<p className="mt-1 text-sm text-muted-foreground">Everything you missed, with why — review it before the exam.</p>
					</div>
					<div className="flex items-center gap-2">
						{analyzing && (
							<>
								<span data-testid="mistakes-progress" className="text-xs text-muted-foreground">
									Analyzing {Math.min(progress.done + 1, progress.total)} of {progress.total}…
								</span>
								<button
									type="button"
									onClick={() => void fetch("/api/mistakes/cancel", { method: "POST" })}
									className="rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
								>
									Cancel
								</button>
							</>
						)}
						<button
							type="button"
							data-testid="mistakes-scan"
							disabled={busy}
							onClick={() => void scan(false)}
							className="rounded-lg border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40"
						>
							Scan past sessions
						</button>
					</div>
				</div>

				{scanNote && (
					<div data-testid="mistakes-scan-note" className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm">
						{scanNote.found === 0 && scanNote.retry === 0 ? (
							<>
								<span className="text-foreground">Nothing new — every miss in your sessions is already here.</span>
								<button type="button" onClick={() => setScanNote(null)} className="ml-auto text-xs text-muted-foreground hover:text-foreground">
									Close
								</button>
							</>
						) : (
							<>
								<span className="text-foreground">
									Found {scanNote.found} new miss{scanNote.found === 1 ? "" : "es"}
									{scanNote.retry > 0 ? ` and ${scanNote.retry} to retry` : ""}. Each gets a short analysis from your cheap model — one call per item,
									within your daily analysis limit.
								</span>
								<span className="ml-auto flex gap-2">
									<button type="button" onClick={() => setScanNote(null)} className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
										Not now
									</button>
									<button
										type="button"
										data-testid="mistakes-scan-confirm"
										disabled={busy}
										onClick={() => void scan(true)}
										className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:opacity-90 disabled:opacity-40"
									>
										Analyze them
									</button>
								</span>
							</>
						)}
					</div>
				)}

				{/* Summary: totals + the error types (click to filter). */}
				<div className="flex flex-wrap items-center gap-2 text-xs" data-testid="mistakes-summary">
					<span className="text-foreground">{summary.total} total</span>
					<span className="text-muted-foreground">
						{summary.missed} missed · {summary.unanswered} unanswered · {summary.problems} problems
						{summary.pending > 0 ? ` · ${summary.pending} being analyzed` : ""}
					</span>
					<span className="mx-1 h-3 border-l" aria-hidden="true" />
					{summary.byType.map(({ type, count }) => (
						<button
							key={type}
							type="button"
							onClick={() => setErrorType((cur) => (cur === type ? "" : type))}
							className={cn(
								"rounded-full border px-2 py-0.5 transition-colors hover:bg-accent",
								errorType === type ? "border-primary bg-accent text-foreground" : "text-muted-foreground",
							)}
						>
							{ERROR_TYPE_LABELS[type]} {count}
						</button>
					))}
				</div>

				<div className="flex flex-wrap items-center gap-2">
					<input
						data-testid="mistakes-search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search mistakes…"
						aria-label="Search mistakes"
						className="lh-input min-w-40 flex-1 rounded-lg border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
					/>
					<div className="flex items-center gap-0.5 rounded-md border border-border/60 bg-background p-0.5" data-testid="mistakes-groupby">
						{GROUPS.map((g) => (
							<button
								key={g.by}
								type="button"
								onClick={() => setBy(g.by)}
								className={cn(
									"rounded-sm px-2 py-1 text-[11px] uppercase tracking-wider transition-colors",
									by === g.by ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{g.label}
							</button>
						))}
					</div>
					<select
						aria-label="Filter by type"
						value={kind}
						onChange={(e) => setKind(e.target.value as MistakeKind | "")}
						className="rounded-lg border bg-background px-2 py-1.5 text-xs"
					>
						<option value="">All kinds</option>
						{(Object.keys(KIND_LABEL) as MistakeKind[]).map((k) => (
							<option key={k} value={k}>
								{KIND_LABEL[k]}
							</option>
						))}
					</select>
					<select
						aria-label="Filter by error type"
						value={errorType}
						onChange={(e) => setErrorType(e.target.value as ErrorType | "")}
						className="rounded-lg border bg-background px-2 py-1.5 text-xs"
					>
						<option value="">All error types</option>
						{ERROR_TYPES.map((t) => (
							<option key={t} value={t}>
								{ERROR_TYPE_LABELS[t]}
							</option>
						))}
					</select>
					<select
						aria-label="Filter by session"
						value={chatId}
						onChange={(e) => setChatId(e.target.value)}
						className="max-w-44 rounded-lg border bg-background px-2 py-1.5 text-xs"
					>
						<option value="">All sessions</option>
						{sessions.map(([id, title]) => (
							<option key={id} value={id}>
								{title}
							</option>
						))}
					</select>
					<button
						type="button"
						data-testid="mistakes-expand-all"
						onClick={() => setOpen((prev) => (prev.size >= filtered.length && filtered.length > 0 ? new Set() : new Set(filtered.map((r) => r.id))))}
						className="rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
					>
						{open.size >= filtered.length && filtered.length > 0 ? "Collapse all" : "Expand all"}
					</button>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto" data-testid="mistakes-list">
					{records === null ? (
						<p className="text-sm text-muted-foreground">Loading…</p>
					) : records.length === 0 ? (
						<div className="rounded-2xl border bg-card p-6 text-sm text-muted-foreground">
							No mistakes yet. Quiz misses, “I don’t know”, and practice problems you don’t solve cleanly land here with a short
							analysis. Use <span className="text-foreground">Scan past sessions</span> to pull in ones from before.
						</div>
					) : filtered.length === 0 ? (
						<p className="text-sm text-muted-foreground">No mistakes match.</p>
					) : (
						<div className="flex flex-col gap-5">
							{groups.map((g) => {
								const collapsed = closedGroups.has(g.key);
								return (
									<section key={g.key} data-testid="mistakes-group">
										<button
											type="button"
											onClick={() => toggleGroup(g.key)}
											className="mb-2 flex w-full items-center gap-2 text-left"
										>
											{collapsed ? <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" /> : <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" />}
											<span className="font-title text-lg tracking-tight text-foreground">{g.label}</span>
											<span className="text-xs text-muted-foreground">{g.records.length}</span>
											{g.pattern && <span className="ml-2 truncate text-xs text-muted-foreground/80" data-testid="mistakes-pattern">Pattern: {g.pattern}</span>}
										</button>
										{!collapsed && (
											<div className="flex flex-col gap-2">
												{g.records.map((r) => (
													<MistakeCard key={r.id} record={r} open={open.has(r.id)} onToggle={() => toggle(r.id)} onDelete={() => void remove(r.id)} onRetry={() => void retry(r.id)} />
												))}
											</div>
										)}
									</section>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function MistakeCard({
	record: r,
	open,
	onToggle,
	onDelete,
	onRetry,
}: {
	record: MistakeRecord;
	open: boolean;
	onToggle: () => void;
	onDelete: () => void;
	onRetry: () => void;
}) {
	const a = r.analysis;
	return (
		<div className="rounded-xl border bg-card" data-testid="mistake-card">
			<button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-start gap-2 px-4 py-3 text-left">
				{open ? <ChevronDownIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
				<span className="min-w-0 flex-1">
					<span className={cn("block font-prose text-(length:--lh-prose-size)", !open && "line-clamp-2")}>{r.question}</span>
					<span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
						<span className="rounded-sm border px-1.5 py-0.5 text-muted-foreground">{KIND_LABEL[r.kind]}</span>
						{a ? (
							<span className="rounded-sm bg-accent px-1.5 py-0.5 text-foreground">{ERROR_TYPE_LABELS[a.errorType]}</span>
						) : r.status === "pending" ? (
							<span className="text-muted-foreground">Analyzing…</span>
						) : (
							<span className="text-muted-foreground" title={r.error}>Analysis unavailable</span>
						)}
						{a && <span className="text-muted-foreground">{a.topic}</span>}
					</span>
					{!open && a && <span className="mt-1.5 block truncate text-xs text-muted-foreground">Next time: {a.rule}</span>}
				</span>
			</button>
			{open && (
				<div className="flex flex-col gap-3 border-t px-4 py-3 text-sm" data-testid="mistake-card-body">
					<div className="grid gap-2 sm:grid-cols-2">
						<div className="rounded-lg bg-muted px-3 py-2">
							<div className="text-[11px] uppercase tracking-wider text-muted-foreground">You</div>
							<ToolContentResponse>{r.yourAnswer}</ToolContentResponse>
						</div>
						<div className="rounded-lg bg-muted px-3 py-2">
							<div className="text-[11px] uppercase tracking-wider text-muted-foreground">Correct</div>
							<ToolContentResponse>{r.correctAnswer}</ToolContentResponse>
						</div>
					</div>
					{a ? (
						<div className="flex flex-col gap-1.5">
							<ToolContentResponse>{a.whatYouDid}</ToolContentResponse>
							<ToolContentResponse>{a.correct}</ToolContentResponse>
							<div className="rounded-lg border border-border/60 px-3 py-2">
								<span className="font-medium text-muted-foreground">Next time: </span>
								<ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{a.rule}</ToolContentResponse>
							</div>
						</div>
					) : r.explanation ? (
						<div>
							<span className="font-medium text-muted-foreground">Why: </span>
							<ToolContentResponse className="inline [&>p:first-child]:inline [&>p:first-child]:m-0">{r.explanation}</ToolContentResponse>
						</div>
					) : null}
					{r.status === "failed" && r.error && <p className="text-xs text-muted-foreground" data-testid="mistake-error">{r.error}</p>}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
						<Link href={`/chat/${r.chatId}`} className="hover:text-foreground" data-testid="mistake-session-link">
							{r.sessionTitle || "Untitled session"}
						</Link>
						{r.sources.length > 0 && <span className="truncate">{r.sources.join(", ")}</span>}
						{typeof r.confidence === "number" && <span>{r.confidence}% sure</span>}
						<span>{new Date(r.answeredAt).toLocaleDateString()}</span>
						<span className="ml-auto flex items-center gap-1">
							{r.status === "failed" && (
								<button type="button" onClick={onRetry} className="rounded-md px-2 py-1 hover:bg-accent hover:text-foreground">
									Retry analysis
								</button>
							)}
							<button type="button" aria-label="Delete mistake" onClick={onDelete} className="rounded-md p-1.5 hover:bg-accent hover:text-foreground">
								<TrashIcon className="size-3.5" />
							</button>
						</span>
					</div>
				</div>
			)}
		</div>
	);
}
