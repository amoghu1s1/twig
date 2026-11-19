"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
	BookOpenIcon,
	CalculatorIcon,
	CircleXIcon,
	CompassIcon,
	DumbbellIcon,
	HammerIcon,
	KeyboardIcon,
	MessageSquareIcon,
	NotebookPenIcon,
	PanelLeftIcon,
	PencilRulerIcon,
	PlusIcon,
	RepeatIcon,
	SearchIcon,
	SettingsIcon,
	SparklesIcon,
	Volume2Icon,
	WaypointsIcon,
} from "lucide-react";
import { HostDialog } from "@/components/host-dialog";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import {
	loadSessionTags,
	SESSION_TAGS_CHANGED_EVENT,
	SESSION_TAGS_KEY,
	type SessionTagsMap,
} from "@/components/session-tags";
import {
	formatBinding,
	fuzzyScore,
	kbdEventForAction,
	KEYBOARD_ACTIONS,
	loadOverrides,
	READING_KIND_LABEL,
	type ChatKind,
	type ChatListItem,
	type GraphNode,
	type GraphSnapshot,
	type ReadingSummary,
} from "@/src/core";

/**
 * Pending Track 2 (`notes-shortcuts`) adding "command-palette", "toggle-notes",
 * and "toggle-readings" to src/core/keyboard.ts; identical spelling to
 * kbdEventForAction(...).
 */
export const COMMAND_PALETTE_EVENT = "lh:kbd-command-palette";
export const TOGGLE_NOTES_EVENT = "lh:kbd-toggle-notes";
export const TOGGLE_READINGS_EVENT = "lh:kbd-toggle-readings";
export const GRAPH_FOCUS_NODE_EVENT = "lh:graph-focus-node";

export type PaletteCategory = "action" | "session" | "reading" | "node";

export type PaletteExecution =
	| { kind: "route"; href: string; focusNodeId?: string }
	| { kind: "event"; eventName: string }
	| { kind: "settings" };

export interface PaletteItem {
	id: string;
	category: PaletteCategory;
	title: string;
	subtitle?: string;
	badge?: string;
	tags?: string[];
	shortcut?: string | null;
	iconKey?: string;
	searchFields: string[];
	execution: PaletteExecution;
}

export interface PaletteSection {
	category: PaletteCategory;
	label: string;
	items: PaletteItem[];
}

const CATEGORY_ORDER: Record<PaletteCategory, number> = {
	action: 0,
	session: 1,
	reading: 2,
	node: 3,
};

const SECTION_LABELS: Record<PaletteCategory, string> = {
	action: "Actions",
	session: "Sessions",
	reading: "Readings",
	node: "Graph nodes",
};

const DEFAULT_RANK_LIMIT = 50;

export function sessionKindLabel(kind: ChatKind | undefined): string {
	if (kind === "practice") return "Practice";
	if (kind === "capstone") return "Capstone";
	return "Teaching";
}

function liveShortcutForAction(actionId: string): string | null {
	const overrides = loadOverrides() as Record<string, string | undefined>;
	const def = (KEYBOARD_ACTIONS as readonly { id: string; binding: string }[]).find((a) => a.id === actionId);
	const binding = overrides[actionId] ?? def?.binding;
	return binding ? formatBinding(binding) : null;
}

function resolveShortcutsMap(): Record<string, string | null> {
	return {
		"new-session": liveShortcutForAction("new-session"),
		"open-settings": liveShortcutForAction("open-settings"),
		"jump-graph": liveShortcutForAction("jump-graph"),
		"toggle-sidebar": liveShortcutForAction("toggle-sidebar"),
		"toggle-notes": liveShortcutForAction("toggle-notes"),
		"toggle-readings": liveShortcutForAction("toggle-readings"),
		"toggle-scratchpad": liveShortcutForAction("toggle-scratchpad"),
		"toggle-calculator": liveShortcutForAction("toggle-calculator"),
		"read-by-sentence": liveShortcutForAction("read-by-sentence"),
	};
}

/** Built-in app navigation, creation, and tool toggle items (always available offline). */
export function builtInPaletteActions(shortcuts: Partial<Record<string, string | null>> = {}): PaletteItem[] {
	return [
		{
			id: "action:new-teach",
			category: "action",
			title: "New teaching session",
			badge: "Action",
			shortcut: shortcuts["new-session"] ?? null,
			iconKey: "new-teach",
			searchFields: ["New teaching session", "create teach chat session"],
			execution: { kind: "route", href: "/chat/new" },
		},
		{
			id: "action:new-practice",
			category: "action",
			title: "New practice session",
			badge: "Action",
			iconKey: "new-practice",
			searchFields: ["New practice session", "create practice quiz exercises"],
			execution: { kind: "route", href: "/chat/new?mode=practice" },
		},
		{
			id: "action:new-capstone",
			category: "action",
			title: "New capstone session",
			badge: "Action",
			iconKey: "new-capstone",
			searchFields: ["New capstone session", "create capstone project build"],
			execution: { kind: "route", href: "/chat/new?mode=capstone" },
		},
		{
			id: "action:open-settings",
			category: "action",
			title: "Open Settings",
			badge: "Action",
			shortcut: shortcuts["open-settings"] ?? null,
			iconKey: "settings",
			searchFields: ["Open Settings", "preferences config appearance keys models keyboard"],
			execution: { kind: "settings" },
		},
		{
			id: "action:open-graph",
			category: "action",
			title: "Open Knowledge Graph",
			badge: "Action",
			shortcut: shortcuts["jump-graph"] ?? null,
			iconKey: "graph",
			searchFields: ["Open Knowledge Graph", "home map propositions"],
			execution: { kind: "route", href: "/" },
		},
		{
			id: "action:open-readings",
			category: "action",
			title: "Open Readings library",
			badge: "Action",
			iconKey: "readings",
			searchFields: ["Open Readings library", "companion documents primer overview recap"],
			execution: { kind: "route", href: "/readings" },
		},
		{
			id: "action:open-review",
			category: "action",
			title: "Open Review queue",
			badge: "Action",
			iconKey: "review",
			searchFields: ["Open Review queue", "spaced repetition flashcards anki"],
			execution: { kind: "route", href: "/review" },
		},
		{
			id: "action:open-mistakes",
			category: "action",
			title: "Open Mistakes",
			badge: "Action",
			iconKey: "mistakes",
			searchFields: ["Open Mistakes", "errors wrong misses"],
			execution: { kind: "route", href: "/mistakes" },
		},
		{
			id: "action:toggle-sidebar",
			category: "action",
			title: "Toggle Sidebar",
			badge: "Tool",
			shortcut: shortcuts["toggle-sidebar"] ?? null,
			iconKey: "sidebar",
			searchFields: ["Toggle Sidebar", "sessions panel navigation"],
			execution: { kind: "event", eventName: kbdEventForAction("toggle-sidebar") },
		},
		{
			id: "action:toggle-notes",
			category: "action",
			title: "Toggle Notes",
			badge: "Tool",
			shortcut: shortcuts["toggle-notes"] ?? null,
			iconKey: "notes",
			searchFields: ["Toggle Notes", "lesson markdown notes panel"],
			execution: { kind: "event", eventName: TOGGLE_NOTES_EVENT },
		},
		{
			id: "action:toggle-readings",
			category: "action",
			title: "Toggle Readings tray",
			badge: "Tool",
			shortcut: shortcuts["toggle-readings"] ?? null,
			iconKey: "readings",
			searchFields: ["Toggle Readings tray", "session readings drawer"],
			execution: { kind: "event", eventName: TOGGLE_READINGS_EVENT },
		},
		{
			id: "action:toggle-scratchpad",
			category: "action",
			title: "Toggle Scratchpad",
			badge: "Tool",
			shortcut: shortcuts["toggle-scratchpad"] ?? null,
			iconKey: "scratchpad",
			searchFields: ["Toggle Scratchpad", "drawing board whiteboard canvas"],
			execution: { kind: "event", eventName: kbdEventForAction("toggle-scratchpad") },
		},
		{
			id: "action:toggle-calculator",
			category: "action",
			title: "Toggle Calculator",
			badge: "Tool",
			shortcut: shortcuts["toggle-calculator"] ?? null,
			iconKey: "calculator",
			searchFields: ["Toggle Calculator", "math scientific compute"],
			execution: { kind: "event", eventName: kbdEventForAction("toggle-calculator") },
		},
		{
			id: "action:read-by-sentence",
			category: "action",
			title: "Read latest passage",
			badge: "Tool",
			shortcut: shortcuts["read-by-sentence"] ?? null,
			iconKey: "reader",
			searchFields: ["Read latest passage", "read by sentence dyslexia spotlight tts"],
			execution: { kind: "event", eventName: kbdEventForAction("read-by-sentence") },
		},
	];
}

/** Combine actions, sessions (with subject tags), readings, and graph proposition nodes. */
export function buildPaletteItems({
	chats = [],
	readings = [],
	nodes = [],
	tagsMap = {},
	shortcuts = {},
}: {
	chats?: readonly ChatListItem[];
	readings?: readonly ReadingSummary[];
	nodes?: readonly GraphNode[];
	tagsMap?: SessionTagsMap;
	shortcuts?: Partial<Record<string, string | null>>;
}): PaletteItem[] {
	const actions = builtInPaletteActions(shortcuts);

	const sessionItems: PaletteItem[] = chats.map((c) => {
		const kindLabel = sessionKindLabel(c.kind);
		const tags = tagsMap[c.id] ?? [];
		return {
			id: `session:${c.id}`,
			category: "session",
			title: c.title,
			badge: kindLabel,
			tags,
			searchFields: [c.title, ...tags, kindLabel],
			execution: { kind: "route", href: `/chat/${c.id}` },
		};
	});

	const readingItems: PaletteItem[] = readings.map((r) => {
		const kindLabel = READING_KIND_LABEL[r.kind] ?? r.kind;
		return {
			id: `reading:${r.id}`,
			category: "reading",
			title: r.title,
			subtitle: r.chatTitle,
			badge: kindLabel,
			searchFields: [r.title, kindLabel, ...(r.chatTitle ? [r.chatTitle] : [])],
			execution: { kind: "route", href: `/readings/${r.id}` },
		};
	});

	const nodeItems: PaletteItem[] = nodes
		.filter((n) => !n.id.startsWith("arg_"))
		.map((n) => ({
			id: `node:${n.id}`,
			category: "node",
			title: n.name,
			subtitle: n.statement,
			badge: "Node",
			searchFields: [n.name, n.statement, ...(n.aliases ?? [])],
			execution: {
				kind: "route",
				href: `/?node=${encodeURIComponent(n.id)}`,
				focusNodeId: n.id,
			},
		}));

	return [...actions, ...sessionItems, ...readingItems, ...nodeItems];
}

/** Group items into visual sections in canonical order (for empty-query view). */
export function groupPaletteItems(items: readonly PaletteItem[]): PaletteSection[] {
	const buckets: Record<PaletteCategory, PaletteItem[]> = {
		action: [],
		session: [],
		reading: [],
		node: [],
	};
	for (const item of items) buckets[item.category].push(item);
	return (["action", "session", "reading", "node"] as const)
		.filter((category) => buckets[category].length > 0)
		.map((category) => ({
			category,
			label: SECTION_LABELS[category],
			items: buckets[category],
		}));
}

/**
 * Filter and rank palette items by `query`.
 * Empty query returns grouped items capped cleanly; non-empty query fuzzy-scores
 * every candidate across all searchFields, prioritizing direct title/tag hits.
 */
export function rankPaletteItems(
	items: readonly PaletteItem[],
	query: string,
	limit = DEFAULT_RANK_LIMIT,
): PaletteItem[] {
	const trimmed = query.trim();
	if (!trimmed) {
		const sections = groupPaletteItems(items);
		const flat = sections.flatMap((s) => s.items);
		return limit > 0 ? flat.slice(0, limit) : flat;
	}

	const scored: Array<{ item: PaletteItem; score: number; index: number }> = [];
	items.forEach((item, index) => {
		const base = fuzzyScore(trimmed, ...item.searchFields);
		if (base === null) return;
		const titleBoost = fuzzyScore(trimmed, item.title);
		const score = base + (titleBoost !== null ? 25 : 0);
		scored.push({ item, score, index });
	});

	scored.sort(
		(a, b) =>
			b.score - a.score ||
			CATEGORY_ORDER[a.item.category] - CATEGORY_ORDER[b.item.category] ||
			a.index - b.index,
	);
	const ranked = scored.map((entry) => entry.item);
	return limit > 0 ? ranked.slice(0, limit) : ranked;
}

function PaletteRowIcon({ item }: { item: PaletteItem }) {
	const cls = "size-3.5 shrink-0 text-muted-foreground";
	if (item.category === "session") return <MessageSquareIcon className={cls} />;
	if (item.category === "reading") return <BookOpenIcon className={cls} />;
	if (item.category === "node") return <WaypointsIcon className={cls} />;
	switch (item.iconKey) {
		case "new-teach":
			return <PlusIcon className={cls} />;
		case "new-practice":
			return <DumbbellIcon className={cls} />;
		case "new-capstone":
			return <HammerIcon className={cls} />;
		case "settings":
			return <SettingsIcon className={cls} />;
		case "graph":
			return <CompassIcon className={cls} />;
		case "readings":
			return <BookOpenIcon className={cls} />;
		case "review":
			return <RepeatIcon className={cls} />;
		case "mistakes":
			return <CircleXIcon className={cls} />;
		case "sidebar":
			return <PanelLeftIcon className={cls} />;
		case "notes":
			return <NotebookPenIcon className={cls} />;
		case "scratchpad":
			return <PencilRulerIcon className={cls} />;
		case "calculator":
			return <CalculatorIcon className={cls} />;
		case "reader":
			return <Volume2Icon className={cls} />;
		default:
			return <SparklesIcon className={cls} />;
	}
}

export interface CommandPaletteProps {
	/** Optional override for tests to render pre-opened without keydown dispatch. */
	initialOpen?: boolean;
	/** Optional settings callback override for tests outside SettingsDialogProvider. */
	onOpenSettings?: () => void;
}

export function CommandPalette({ initialOpen = false, onOpenSettings }: CommandPaletteProps = {}) {
	const router = useRouter();
	const { open: openSettingsDialog } = useSettingsDialog();
	const openSettings = onOpenSettings ?? openSettingsDialog;

	const [open, setOpen] = useState(initialOpen);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [chats, setChats] = useState<ChatListItem[]>([]);
	const [readings, setReadings] = useState<ReadingSummary[]>([]);
	const [nodes, setNodes] = useState<GraphNode[]>([]);
	const [tagsMap, setTagsMap] = useState<SessionTagsMap>({});
	const [shortcuts, setShortcuts] = useState<Record<string, string | null>>({});
	const [loadingCount, setLoadingCount] = useState(0);

	const inputRef = useRef<HTMLInputElement>(null);
	const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const pendingAfterCloseRef = useRef<PaletteExecution | null>(null);

	// Toggle on Mod+P window event (`lh:kbd-command-palette`).
	useEffect(() => {
		const onToggle = () => {
			setOpen((prev) => {
				const next = !prev;
				if (next) {
					setQuery("");
					setActiveIndex(0);
				}
				return next;
			});
		};
		window.addEventListener(COMMAND_PALETTE_EVENT, onToggle);
		return () => window.removeEventListener(COMMAND_PALETTE_EVENT, onToggle);
	}, []);

	// Sync localStorage tags and live shortcut overrides whenever open or tags change.
	useEffect(() => {
		if (!open) return;
		setTagsMap(loadSessionTags());
		setShortcuts(resolveShortcutsMap());
		const syncTags = () => setTagsMap(loadSessionTags());
		const onStorage = (e: StorageEvent) => {
			if (e.key === SESSION_TAGS_KEY) syncTags();
		};
		window.addEventListener(SESSION_TAGS_CHANGED_EVENT, syncTags);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(SESSION_TAGS_CHANGED_EVENT, syncTags);
			window.removeEventListener("storage", onStorage);
		};
	}, [open]);

	// Non-blocking parallel fetches on open (abort stale requests on close).
	useEffect(() => {
		if (!open) {
			setLoadingCount(0);
			return;
		}
		const ac = new AbortController();
		let pending = 3;
		setLoadingCount(pending);
		const doneOne = () => {
			if (!ac.signal.aborted) {
				pending -= 1;
				setLoadingCount(Math.max(0, pending));
			}
		};

		fetch("/api/chats", { cache: "no-store", signal: ac.signal })
			.then((res) => (res.ok ? (res.json() as Promise<{ chats?: ChatListItem[] }>) : null))
			.then((data) => {
				if (!ac.signal.aborted && Array.isArray(data?.chats)) setChats(data.chats);
			})
			.catch(() => {})
			.finally(doneOne);

		fetch("/api/readings", { cache: "no-store", signal: ac.signal })
			.then((res) => (res.ok ? (res.json() as Promise<{ readings?: ReadingSummary[] }>) : null))
			.then((data) => {
				if (!ac.signal.aborted && Array.isArray(data?.readings)) setReadings(data.readings);
			})
			.catch(() => {})
			.finally(doneOne);

		fetch("/api/graph", { cache: "no-store", signal: ac.signal })
			.then((res) => (res.ok ? (res.json() as Promise<Partial<GraphSnapshot>>) : null))
			.then((data) => {
				if (ac.signal.aborted || !data) return;
				const list = Array.isArray(data.propositions)
					? data.propositions
					: Array.isArray(data.nodes)
						? data.nodes
						: null;
				if (list) setNodes(list);
			})
			.catch(() => {})
			.finally(doneOne);

		return () => ac.abort();
	}, [open]);

	const allItems = useMemo(
		() => buildPaletteItems({ chats, readings, nodes, tagsMap, shortcuts }),
		[chats, readings, nodes, tagsMap, shortcuts],
	);

	const results = useMemo(() => rankPaletteItems(allItems, query), [allItems, query]);
	const isSearching = query.trim() !== "";
	const sections = useMemo(() => (isSearching ? null : groupPaletteItems(results)), [isSearching, results]);

	// Keep activeIndex in bounds when async results arrive or filtering narrows the list.
	useEffect(() => {
		setActiveIndex((idx) => {
			if (results.length === 0) return 0;
			return Math.min(idx, results.length - 1);
		});
	}, [results.length]);

	// Keep active row scrolled into view during ArrowUp/ArrowDown navigation.
	useEffect(() => {
		if (!open || results.length === 0) return;
		itemRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
	}, [open, activeIndex, results.length]);

	// Run deferred event / modal actions right after HostDialog unmounts so
	// foreground modal checks (`sessionFindHasForegroundLayer`) and focus return stay clean.
	useEffect(() => {
		if (open) return;
		const pending = pendingAfterCloseRef.current;
		if (!pending) return;
		pendingAfterCloseRef.current = null;
		if (pending.kind === "settings") {
			openSettings();
		} else if (pending.kind === "event") {
			window.dispatchEvent(new CustomEvent(pending.eventName));
		} else if (pending.kind === "route" && pending.focusNodeId) {
			window.dispatchEvent(
				new CustomEvent(GRAPH_FOCUS_NODE_EVENT, { detail: { nodeId: pending.focusNodeId } }),
			);
		}
	}, [open, openSettings]);

	const executeItem = useCallback(
		(item: PaletteItem) => {
			const exec = item.execution;
			if (exec.kind === "route") {
				if (exec.focusNodeId) pendingAfterCloseRef.current = exec;
				setOpen(false);
				router.push(exec.href);
				return;
			}
			pendingAfterCloseRef.current = exec;
			setOpen(false);
		},
		[router],
	);

	const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "ArrowDown") {
			if (results.length === 0) return;
			e.preventDefault();
			setActiveIndex((i) => (i + 1) % results.length);
			return;
		}
		if (e.key === "ArrowUp") {
			if (results.length === 0) return;
			e.preventDefault();
			setActiveIndex((i) => (i - 1 + results.length) % results.length);
			return;
		}
		if (e.key === "Enter") {
			const item = results[activeIndex];
			if (!item) return;
			e.preventDefault();
			executeItem(item);
		}
	};

	const renderRow = (item: PaletteItem, idx: number) => {
		const active = idx === activeIndex;
		return (
			<button
				key={item.id}
				ref={(el) => {
					itemRefs.current[idx] = el;
				}}
				type="button"
				role="option"
				aria-selected={active}
				data-testid="command-palette-item"
				data-active={active ? "true" : undefined}
				data-category={item.category}
				onMouseEnter={() => setActiveIndex(idx)}
				onClick={() => executeItem(item)}
				className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${
					active ? "bg-accent text-foreground" : "text-foreground/90 hover:bg-accent/60"
				}`}
			>
				<PaletteRowIcon item={item} />
				<span className="min-w-0 flex-1">
					<span className="flex items-center gap-1.5">
						<span className="truncate font-prose text-sm leading-snug">{item.title}</span>
						{item.tags && item.tags.length > 0 && (
							<span className="flex shrink-0 items-center gap-1">
								{item.tags.slice(0, 2).map((tag) => (
									<span
										key={tag}
										className="max-w-[7rem] truncate rounded-sm border border-border/60 bg-background/60 px-1.5 py-px font-ui text-[10px] text-muted-foreground"
									>
										{tag}
									</span>
								))}
								{item.tags.length > 2 && (
									<span className="font-ui text-[10px] text-muted-foreground/80 tabular-nums">
										+{item.tags.length - 2}
									</span>
								)}
							</span>
						)}
					</span>
					{item.subtitle && (
						<span className="block truncate text-[11px] text-muted-foreground">{item.subtitle}</span>
					)}
				</span>
				{item.badge && (
					<span className="shrink-0 rounded border border-border/60 bg-background/50 px-1.5 py-0.5 font-ui text-[10px] uppercase tracking-wider text-muted-foreground">
						{item.badge}
					</span>
				)}
				{item.shortcut && (
					<kbd className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
						{item.shortcut}
					</kbd>
				)}
			</button>
		);
	};

	let flatOffset = 0;

	return (
		<HostDialog
			open={open}
			onClose={() => {
				setOpen(false);
				return "closed";
			}}
			initialFocusRef={inputRef}
			aria-label="Command palette"
			backdropProps={{
				"data-testid": "command-palette-backdrop",
				className: "fixed inset-0 z-50 flex items-start justify-center bg-background/80 px-4 pt-[14vh]",
			}}
			frame={
				<div
					data-testid="command-palette"
					className="w-full max-w-xl overflow-hidden rounded-xl border bg-card shadow-2xl"
					onClick={(e) => e.stopPropagation()}
				/>
			}
		>
			<div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
				<SearchIcon className="size-4 shrink-0 text-muted-foreground" />
				<input
					ref={inputRef}
					type="text"
					data-testid="command-palette-input"
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setActiveIndex(0);
					}}
					onKeyDown={onInputKeyDown}
					placeholder="Jump to session, reading, graph node, or action…"
					aria-label="Command palette search"
					spellCheck={false}
					className="w-full min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
				/>
				<kbd className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
					Esc
				</kbd>
			</div>

			<div
				data-testid="command-palette-list"
				role="listbox"
				aria-label="Command palette results"
				className="max-h-[60vh] overflow-y-auto p-1.5"
			>
				{results.length === 0 ? (
					<div data-testid="command-palette-empty" className="px-3 py-8 text-center text-xs text-muted-foreground">
						No matching sessions, readings, nodes, or actions.
					</div>
				) : sections ? (
					sections.map((section) => {
						const startIdx = flatOffset;
						flatOffset += section.items.length;
						return (
							<div key={section.category} className="mb-1.5 last:mb-0">
								<div className="px-2.5 pb-1 pt-1.5 font-ui text-[10px] uppercase tracking-widest text-muted-foreground/70">
									{section.label}
								</div>
								<div className="flex flex-col gap-0.5">
									{section.items.map((item, localIdx) => renderRow(item, startIdx + localIdx))}
								</div>
							</div>
						);
					})
				) : (
					<div className="flex flex-col gap-0.5">
						{results.map((item, idx) => renderRow(item, idx))}
					</div>
				)}
			</div>

			<div className="flex items-center justify-between border-t border-border/70 px-3 py-1.5 font-ui text-[10px] text-muted-foreground/75">
				<span className="flex items-center gap-2">
					<KeyboardIcon className="size-3" />
					<span>↑↓ navigate · ↵ select · Esc close</span>
				</span>
				{loadingCount > 0 && <span className="tabular-nums">Syncing…</span>}
			</div>
		</HostDialog>
	);
}
