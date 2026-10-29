"use client";

/**
 * THE SESSION'S READINGS TRAY (docs/readings.md §6/§8; owner ruling
 * 2026-10-27: a side tray beside the lesson, the transcript untouched).
 * Two views in one panel: the LIST (new-reading controls + this session's
 * readings) and the READER (one reading, live). The lesson stays visible
 * and running behind it; nothing here writes into the transcript, and the
 * teacher never learns a reading was requested (owner ruling: no marker) —
 * only a Discuss exchange reaches it, as a held note (docs/readings.md §14).
 *
 * Also the provider of the session's readings seam (SessionReadingsContext)
 * so the plan popup, the passage action, and the teacher's offer cards can
 * create a reading and open it here.
 */

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { ArrowLeftIcon, BookOpenIcon, LibraryIcon, MapIcon, NotebookTextIcon, ScrollTextIcon, SparklesIcon, XIcon } from "lucide-react";
import Link from "next/link";
import type { PlanTree, ReadingKind, ReadingRequest, ReadingSummary } from "@/src/core";
import { READING_KIND_LABEL } from "@/src/core";
import { BrailleSpinner } from "@/components/braille-spinner";
import { ago, requestReading, SessionReadingsContext, useReadingMode, useReadings, type SessionReadings } from "@/components/readings/api";
import { ModeLabel, ModeToggle, ReadingView } from "@/components/readings/reading-view";

/** The tray's open state + the session seam, owned by the chat page. */
export function useReadingsTray(chatId: string, enabled: boolean) {
	const [open, setOpen] = useState(false);
	const [readingId, setReadingId] = useState<string | null>(null);
	const { readings } = useReadings(enabled ? { chatId } : null);
	const [mode, setMode] = useReadingMode();

	const openTray = useCallback((id?: string) => {
		setReadingId(id ?? null);
		setOpen(true);
	}, []);

	const request = useCallback(
		async (req: Omit<ReadingRequest, "chatId">): Promise<string | null> => {
			const res = await requestReading({ mode, ...req, chatId });
			if (!res.ok) return res.error;
			setReadingId(res.id);
			setOpen(true);
			return null;
		},
		[chatId, mode],
	);

	const seam: SessionReadings = useMemo(
		() => ({ chatId, open: openTray, request, readings: readings ?? [], mode, setMode }),
		[chatId, openTray, request, readings, mode, setMode],
	);
	return { open, setOpen, readingId, setReadingId, seam, readings };
}

export function SessionReadingsProvider({ seam, children }: { seam: SessionReadings; children: ReactNode }) {
	return <SessionReadingsContext.Provider value={seam}>{children}</SessionReadingsContext.Provider>;
}

const KIND_ICON: Record<ReadingKind, typeof BookOpenIcon> = {
	primer: NotebookTextIcon,
	overview: MapIcon,
	"deep-dive": BookOpenIcon,
	recap: ScrollTextIcon,
	node: BookOpenIcon,
};

export function ReadingsTray({
	seam,
	readings,
	readingId,
	onOpenReading,
	onClose,
	tree,
}: {
	seam: SessionReadings;
	readings: ReadingSummary[] | null;
	readingId: string | null;
	onOpenReading: (id: string | null) => void;
	onClose: () => void;
	/** The live plan (deep-dive picker); null before planning. */
	tree: PlanTree | null;
}) {
	return (
		<aside
			data-testid="readings-tray"
			aria-label="Readings"
			className="flex h-full w-[min(28rem,100vw)] shrink-0 flex-col border-l border-border bg-background max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-50 max-lg:shadow-2xl"
		>
			<div className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
				{readingId ? (
					<button
						type="button"
						data-testid="readings-back"
						onClick={() => onOpenReading(null)}
						className="flex items-center gap-1 rounded-md px-1.5 py-1 font-ui text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<ArrowLeftIcon className="size-3.5" /> All readings
					</button>
				) : (
					<span className="flex items-center gap-1.5 font-ui text-xs uppercase tracking-widest text-muted-foreground">
						<BookOpenIcon className="size-3.5" /> Readings
					</span>
				)}
				<span className="ml-auto" />
				{readingId && (
					<Link href={`/readings/${readingId}`} className="rounded-md px-1.5 py-1 font-ui text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
						Open full page
					</Link>
				)}
				<button
					type="button"
					aria-label="Close readings"
					data-testid="readings-close"
					onClick={onClose}
					className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{readingId ? (
					<div className="pt-4">
						<ReadingView id={readingId} compact onDeleted={() => onOpenReading(null)} onOpenReading={(id) => onOpenReading(id)} />
					</div>
				) : (
					<TrayList seam={seam} readings={readings} tree={tree} onOpenReading={onOpenReading} />
				)}
			</div>
		</aside>
	);
}

function TrayList({
	seam,
	readings,
	tree,
	onOpenReading,
}: {
	seam: SessionReadings;
	readings: ReadingSummary[] | null;
	tree: PlanTree | null;
	onOpenReading: (id: string) => void;
}) {
	const [kind, setKind] = useState<"recap" | "primer" | "overview" | "deep-dive">("recap");
	const [nodeId, setNodeId] = useState<string>("");
	const [requestText, setRequestText] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nodes = tree?.nodes ?? [];
	const canCreate = !busy && (kind !== "deep-dive" || nodeId !== "");

	const create = async () => {
		setBusy(true);
		setError(null);
		const err = await seam.request({
			kind,
			...(kind === "deep-dive" ? { planNodeId: nodeId } : {}),
			...(requestText.trim() ? { request: requestText.trim() } : {}),
		});
		setBusy(false);
		if (err) setError(err);
		else setRequestText("");
	};

	const KINDS: Array<{ k: "recap" | "primer" | "overview" | "deep-dive"; label: string; hint: string }> = [
		{ k: "recap", label: "Recap", hint: "What this session built so far, plus further reading" },
		{ k: "primer", label: "Primer", hint: "The lesson's key terms, as definitions" },
		{ k: "overview", label: "Overview", hint: "The map of the whole topic: its parts, why each exists, how they connect" },
		{ k: "deep-dive", label: "Deep dive", hint: "The fuller story of one idea from the plan" },
	];

	return (
		<div className="flex flex-col gap-5 p-4">
			<section data-testid="readings-new" className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/40 p-3">
				<div className="flex items-center gap-1.5 font-ui text-xs font-medium text-foreground">
					<SparklesIcon className="size-3.5 text-primary" /> New reading
				</div>
				<div role="radiogroup" aria-label="Reading kind" className="flex flex-wrap gap-1.5 font-ui text-xs">
					{KINDS.map(({ k, label, hint }) => (
						<button
							key={k}
							type="button"
							role="radio"
							aria-checked={kind === k}
							title={hint}
							data-testid={`reading-kind-${k}`}
							onClick={() => setKind(k)}
							className={`rounded-full border px-3 py-1 transition-colors ${kind === k ? "border-primary/60 bg-primary/10 text-foreground" : "border-border/80 text-muted-foreground hover:text-foreground"}`}
						>
							{label}
						</button>
					))}
				</div>
				<p className="font-ui text-xs text-muted-foreground">{KINDS.find((x) => x.k === kind)!.hint}.</p>
				{kind === "deep-dive" &&
					(nodes.length > 0 ? (
						<select
							data-testid="reading-node-select"
							value={nodeId}
							onChange={(e) => setNodeId(e.target.value)}
							className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
						>
							<option value="">Pick an idea from the plan…</option>
							{nodes.map((n) => (
								<option key={n.id} value={n.id}>
									{n.title}
								</option>
							))}
						</select>
					) : (
						<p className="font-ui text-xs text-muted-foreground">
							No plan yet. Once the teacher presents one, pick an idea here — or select any passage in the lesson and choose “Read deeper”.
						</p>
					))}
				<textarea
					value={requestText}
					onChange={(e) => setRequestText(e.target.value)}
					placeholder="Optional: what should it focus on?"
					rows={2}
					maxLength={2000}
					className="resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground/60"
				/>
				<div className="flex items-center gap-2">
					<ModeToggle mode={seam.mode} onChange={seam.setMode} />
					<button
						type="button"
						data-testid="reading-create"
						disabled={!canCreate}
						onClick={() => void create()}
						className="ml-auto flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 font-ui text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/80 disabled:opacity-50"
					>
						{busy ? <BrailleSpinner label="Starting" /> : null}
						Write it
					</button>
				</div>
				{error && <div className="font-ui text-xs text-destructive">{error}</div>}
				<p className="font-ui text-[0.7rem] leading-relaxed text-muted-foreground/70">
					Readings are optional and written in the background. The lesson carries on, and the teacher doesn’t see them.
				</p>
			</section>

			<section className="flex flex-col gap-1">
				<div className="mb-1 flex items-center font-ui text-xs uppercase tracking-widest text-muted-foreground/70">
					This session
					<Link href="/readings" className="ml-auto flex items-center gap-1 normal-case tracking-normal hover:text-foreground">
						<LibraryIcon className="size-3" /> Library
					</Link>
				</div>
				{readings === null ? (
					<div className="font-ui text-xs text-muted-foreground">Loading…</div>
				) : readings.length === 0 ? (
					<div className="font-ui text-xs text-muted-foreground">No readings yet.</div>
				) : (
					readings.map((r) => <ReadingRow key={r.id} r={r} onOpen={() => onOpenReading(r.id)} />)
				)}
			</section>
		</div>
	);
}

export function ReadingRow({ r, onOpen, href }: { r: ReadingSummary; onOpen?: () => void; href?: string }) {
	const Icon = KIND_ICON[r.kind];
	const live = r.status === "queued" || r.status === "writing";
	const inner = (
		<>
			<Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm font-medium">{r.title}</span>
				<span className="flex items-center gap-1.5 truncate font-ui text-xs text-muted-foreground">
					{live ? (
						<>
							<BrailleSpinner label="Writing" />
							<span className="truncate">{r.activity || "Writing…"}</span>
						</>
					) : r.status === "error" ? (
						<span className="text-destructive">{r.error === "Stopped" ? "Stopped" : "Failed"}</span>
					) : (
						<>
							{READING_KIND_LABEL[r.kind]} · <ModeLabel mode={r.mode} /> · {ago(r.createdAt)}
						</>
					)}
				</span>
			</span>
		</>
	);
	const cls = "flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent";
	return href ? (
		<Link href={href} data-testid="reading-row" className={cls}>
			{inner}
		</Link>
	) : (
		<button type="button" data-testid="reading-row" onClick={onOpen} className={cls}>
			{inner}
		</button>
	);
}
