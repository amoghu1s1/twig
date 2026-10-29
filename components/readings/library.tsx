"use client";

/**
 * THE READINGS LIBRARY (docs/readings.md §8): every reading the learner
 * has asked for, across sessions and the graph — filter by kind, search
 * by title or session, open one as a full page. Also the home of a
 * session-less primer or overview ("on a topic, before you start").
 *
 * The TopBar law: no serif title (that always names a session); the
 * surface label rides in the UI font.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { BookOpenIcon, LibraryIcon, MapIcon, NotebookTextIcon, SearchIcon } from "lucide-react";
import type { ReadingKind } from "@/src/core";
import { TopBar } from "@/components/top-bar";
import { BrailleSpinner } from "@/components/braille-spinner";
import { requestReading, useReadingMode, useReadings } from "@/components/readings/api";
import { ModeToggle, ReadingView } from "@/components/readings/reading-view";
import { ReadingRow } from "@/components/readings/readings-tray";

type Filter = "all" | "recap" | "primer" | "overview" | "deep-dive";

const FILTERS: Array<{ f: Filter; label: string }> = [
	{ f: "all", label: "All" },
	{ f: "recap", label: "Recaps" },
	{ f: "primer", label: "Primers" },
	{ f: "overview", label: "Overviews" },
	{ f: "deep-dive", label: "Deep dives" },
];

function matchesFilter(kind: ReadingKind, f: Filter): boolean {
	if (f === "all") return true;
	if (f === "deep-dive") return kind === "deep-dive" || kind === "node";
	return kind === f;
}

export function ReadingsLibrary() {
	const { readings } = useReadings({});
	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");
	const shown = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (readings ?? []).filter(
			(r) => matchesFilter(r.kind, filter) && (!q || r.title.toLowerCase().includes(q) || (r.chatTitle ?? "").toLowerCase().includes(q)),
		);
	}, [readings, filter, query]);

	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<span className="flex items-center gap-1.5 font-ui text-sm font-medium">
					<LibraryIcon className="size-4 text-primary" /> Readings
				</span>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
					<TopicReading />
					<div className="flex flex-wrap items-center gap-2">
						<div role="tablist" aria-label="Filter readings" className="flex gap-1 font-ui text-xs">
							{FILTERS.map(({ f, label }) => (
								<button
									key={f}
									type="button"
									role="tab"
									aria-selected={filter === f}
									onClick={() => setFilter(f)}
									className={`rounded-full px-3 py-1 transition-colors ${filter === f ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
								>
									{label}
								</button>
							))}
						</div>
						<span className="relative ml-auto">
							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Search…"
								aria-label="Search readings"
								className="h-7 w-52 rounded-md border border-border bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground/60"
							/>
							<SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
						</span>
					</div>
					{readings === null ? (
						<div className="flex items-center gap-2 font-ui text-xs text-muted-foreground">
							<BrailleSpinner label="Loading" /> Loading…
						</div>
					) : shown.length === 0 ? (
						<div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
							<BookOpenIcon className="size-8 opacity-40" strokeWidth={1.25} />
							<div className="text-sm">
								{readings.length === 0 ? "No readings yet." : "Nothing matches."}
							</div>
							{readings.length === 0 && (
								<p className="max-w-sm font-ui text-xs">
									In a teaching session, open <span className="text-foreground">Readings</span> in the top bar for a recap, a primer or an overview, click an idea in the plan, or select a passage and choose “Read deeper”. From the graph, open a node and choose “Deep dive”.
								</p>
							)}
						</div>
					) : (
						<div data-testid="readings-library" className="flex flex-col gap-0.5">
							{shown.map((r) => (
								<div key={r.id} className="flex flex-col">
									<ReadingRow r={r} href={`/readings/${r.id}`} />
									{r.chatTitle && <span className="-mt-1 pb-1 pl-9 font-ui text-[0.7rem] text-muted-foreground/70">{r.chatTitle}</span>}
								</div>
							))}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

/** A primer or overview on a topic before any session exists. */
export function TopicReading({ initialTopic = "" }: { initialTopic?: string }) {
	const router = useRouter();
	const [topic, setTopic] = useState(initialTopic);
	const [mode, setMode] = useReadingMode();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const go = async (kind: "primer" | "overview") => {
		if (!topic.trim()) return;
		setBusy(true);
		setError(null);
		const res = await requestReading({ kind, topic: topic.trim(), mode });
		setBusy(false);
		if (!res.ok) return setError(res.error);
		router.push(`/readings/${res.id}`);
	};
	return (
		<section className="flex flex-col gap-2 rounded-xl border border-border/70 bg-card/40 p-3">
			<div className="flex items-center gap-1.5 font-ui text-xs font-medium">
				<NotebookTextIcon className="size-3.5 text-primary" /> On a topic
				<span className="font-normal text-muted-foreground">— the key terms or the whole map, before you start a session</span>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<input
					value={topic}
					onChange={(e) => setTopic(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") void go("primer");
					}}
					maxLength={500}
					placeholder="e.g. Bayesian inference"
					aria-label="Reading topic"
					className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm placeholder:text-muted-foreground/60"
				/>
				<ModeToggle mode={mode} onChange={setMode} />
				<button
					type="button"
					disabled={busy || !topic.trim()}
					onClick={() => void go("primer")}
					className="rounded-full bg-primary px-3 py-1.5 font-ui text-xs font-medium text-primary-foreground hover:bg-primary/80 disabled:opacity-50"
				>
					Write primer
				</button>
				<button
					type="button"
					data-testid="topic-overview"
					disabled={busy || !topic.trim()}
					onClick={() => void go("overview")}
					className="flex items-center gap-1.5 rounded-full border border-border/80 px-3 py-1.5 font-ui text-xs font-medium hover:bg-accent disabled:opacity-50"
				>
					<MapIcon className="size-3.5" aria-hidden /> Write overview
				</button>
			</div>
			{error && <div className="font-ui text-xs text-destructive">{error}</div>}
		</section>
	);
}

export function ReadingPage({ id }: { id: string }) {
	const router = useRouter();
	return (
		<div className="flex h-dvh flex-col">
			<TopBar>
				<button
					type="button"
					onClick={() => router.push("/readings")}
					className="flex items-center gap-1.5 rounded-md px-1.5 py-1 font-ui text-sm font-medium hover:bg-accent"
				>
					<LibraryIcon className="size-4 text-primary" /> Readings
				</button>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-6xl px-4 py-8">
					<ReadingView id={id} onDeleted={() => router.push("/readings")} />
				</div>
			</div>
		</div>
	);
}
