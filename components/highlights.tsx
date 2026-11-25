"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Trash2Icon } from "lucide-react";
import {
	HIGHLIGHT_COLORS,
	type ChatHighlight,
	type CreateHighlightInput,
	type HighlightColor,
} from "@/src/core";
import {
	captureSelectorInSources,
	chunkPoint,
	rawRangeFor,
	readSourceText,
	sourceElements,
	SOURCE_ATTRIBUTE,
} from "@/components/selection-text";
import { scrollSessionTarget, type SessionScrollContext } from "@/components/session-navigation";
import { useSideChatStore } from "@/components/side-chat-state";

export const HIGHLIGHT_STYLE_ID = "lh-user-highlights-style";
export const SIDE_HL_THREAD_ATTR = "data-highlight-side-thread";
export const SIDE_HL_MESSAGE_ATTR = "data-highlight-side-message";

export const HIGHLIGHT_SWATCH_CSS: Record<HighlightColor, { bg: string; dot: string; label: string }> = {
	yellow: { bg: "color-mix(in oklab, #facc15 32%, transparent)", dot: "#eab308", label: "Yellow" },
	green: { bg: "color-mix(in oklab, #4ade80 30%, transparent)", dot: "#22c55e", label: "Green" },
	blue: { bg: "color-mix(in oklab, #60a5fa 30%, transparent)", dot: "#3b82f6", label: "Blue" },
	pink: { bg: "color-mix(in oklab, #f472b6 30%, transparent)", dot: "#ec4899", label: "Pink" },
};

export function highlightRegistryName(color: HighlightColor): string {
	return `lh-hl-${color}`;
}

/** ::highlight() rules live outside globals.css so Tailwind v4 PostCSS never
 *  rejects the pseudo-element as a parse error (see session-find.tsx). */
export function injectUserHighlightStyles(): void {
	if (typeof document === "undefined" || document.getElementById(HIGHLIGHT_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = HIGHLIGHT_STYLE_ID;
	style.textContent = HIGHLIGHT_COLORS.map(
		(color) => `::highlight(${highlightRegistryName(color)}) { background-color: ${HIGHLIGHT_SWATCH_CSS[color].bg}; }`,
	).join("\n");
	document.head.appendChild(style);
}

export function clearUserHighlights(): void {
	if (typeof CSS === "undefined" || !CSS.highlights) return;
	for (const color of HIGHLIGHT_COLORS) CSS.highlights.delete(highlightRegistryName(color));
}

function sideSourceElements(scope: ParentNode, threadId: string, sideMessageId: string): Element[] {
	return Array.from(scope.querySelectorAll(`[${SIDE_HL_THREAD_ATTR}][${SIDE_HL_MESSAGE_ATTR}]`)).filter(
		(el) =>
			el.getAttribute(SIDE_HL_THREAD_ATTR) === threadId &&
			el.getAttribute(SIDE_HL_MESSAGE_ATTR) === sideMessageId,
	);
}

export function resolveHighlightRange(scope: ParentNode, highlight: ChatHighlight): Range | null {
	const sources =
		highlight.sourceKind === "side" && highlight.sideMessageId
			? sideSourceElements(scope, highlight.sourceId, highlight.sideMessageId)
			: sourceElements(scope, highlight.sourceId);
	if (sources.length === 0) return null;
	const { text, chunks } = readSourceText(sources);
	const raw = rawRangeFor(text, highlight.selector);
	if (!raw) return null;
	const start = chunkPoint(chunks, raw.start, "start");
	const end = chunkPoint(chunks, raw.end, "end");
	if (!start || !end) return null;
	const range = scope.ownerDocument?.createRange() ?? document.createRange();
	if (start.atomic) range.setStartBefore(start.atomic);
	else range.setStart(start.node, start.offset);
	if (end.atomic) range.setEndAfter(end.atomic);
	else range.setEnd(end.node, end.offset);
	return range;
}

/** Capture a highlight target from a non-collapsed DOM Range in either settled
 *  tutor prose or a settled side-chat answer. */
export function captureHighlightTarget(scope: Element, range: Range): Omit<CreateHighlightInput, "color"> | null {
	const elementOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement);
	const startEl = elementOf(range.startContainer);
	const endEl = elementOf(range.endContainer);

	// 1. Check side-chat answer first (side answers sit inside side-chat blocks,
	//    outside [data-source-message-id] or inside [data-side-ui]).
	const startSide = startEl?.closest(`[${SIDE_HL_MESSAGE_ATTR}][${SIDE_HL_THREAD_ATTR}]`);
	if (startSide && scope.contains(startSide)) {
		const threadId = startSide.getAttribute(SIDE_HL_THREAD_ATTR);
		const sideMessageId = startSide.getAttribute(SIDE_HL_MESSAGE_ATTR);
		const endSide = endEl?.closest(`[${SIDE_HL_MESSAGE_ATTR}][${SIDE_HL_THREAD_ATTR}]`);
		if (!threadId || !sideMessageId || (endSide && endSide !== startSide)) return null;
		const captured = captureSelectorInSources([startSide], range);
		if (!captured) return null;
		return {
			sourceKind: "side",
			sourceId: threadId,
			sideMessageId,
			selector: captured.selector,
		};
	}

	// 2. Main tutor prose ([data-source-message-id], excluding live c_ messages).
	let source = startEl?.closest(`[${SOURCE_ATTRIBUTE}]`) ?? null;
	if (!source) {
		source =
			Array.from(scope.querySelectorAll(`[${SOURCE_ATTRIBUTE}]`)).find((el) => range.intersectsNode(el)) ?? null;
	}
	if (!source || !scope.contains(source)) return null;
	const messageId = source.getAttribute(SOURCE_ATTRIBUTE);
	if (!messageId || messageId.startsWith("c_")) return null;
	const endSource = endEl?.closest(`[${SOURCE_ATTRIBUTE}]`);
	if (endSource && endSource.getAttribute(SOURCE_ATTRIBUTE) !== messageId) return null;
	const captured = captureSelectorInSources(sourceElements(scope, messageId), range);
	if (!captured) return null;
	return {
		sourceKind: "tutor",
		sourceId: messageId,
		selector: captured.selector,
	};
}

function publishHighlightRanges(
	scope: HTMLElement,
	highlights: readonly ChatHighlight[],
): Array<{ highlight: ChatHighlight; range: Range }> {
	const active: Array<{ highlight: ChatHighlight; range: Range }> = [];
	const byColor = new Map<HighlightColor, Range[]>(HIGHLIGHT_COLORS.map((c) => [c, []]));
	for (const h of highlights) {
		const range = resolveHighlightRange(scope, h);
		if (!range) continue;
		active.push({ highlight: h, range });
		byColor.get(h.color)!.push(range);
	}
	if (typeof CSS !== "undefined" && CSS.highlights && typeof Highlight !== "undefined") {
		for (const color of HIGHLIGHT_COLORS) {
			const ranges = byColor.get(color)!;
			const name = highlightRegistryName(color);
			if (ranges.length === 0) {
				CSS.highlights.delete(name);
			} else {
				const reg = new Highlight();
				reg.priority = 0; // SessionFind active match uses priority 1
				for (const r of ranges) reg.add(r);
				CSS.highlights.set(name, reg);
			}
		}
	}
	return active;
}

export interface ChatHighlightsContextValue {
	highlights: readonly ChatHighlight[];
	addHighlight: (input: CreateHighlightInput) => Promise<ChatHighlight | null>;
	recolorHighlight: (highlightId: string, color: HighlightColor) => Promise<void>;
	removeHighlight: (highlightId: string) => Promise<void>;
	jumpToHighlight: (highlight: ChatHighlight) => void;
}

const ChatHighlightsContext = createContext<ChatHighlightsContextValue | null>(null);

export function useOptionalChatHighlights(): ChatHighlightsContextValue | null {
	return useContext(ChatHighlightsContext);
}

export function ChatHighlightsProvider({
	chatId,
	scopeRef,
	scrollContextRef,
	children,
}: {
	chatId: string;
	scopeRef: RefObject<HTMLDivElement | null>;
	scrollContextRef: RefObject<SessionScrollContext | null>;
	children: ReactNode;
}) {
	const [highlights, setHighlights] = useState<ChatHighlight[]>([]);
	const [popover, setPopover] = useState<{ highlight: ChatHighlight; x: number; y: number } | null>(null);
	const activeRangesRef = useRef<Array<{ highlight: ChatHighlight; range: Range }>>([]);
	const popoverRef = useRef<HTMLDivElement>(null);
	const sideStore = useSideChatStore();

	useEffect(injectUserHighlightStyles, []);
	useEffect(() => clearUserHighlights, []);

	useEffect(() => {
		let cancelled = false;
		setHighlights([]);
		setPopover(null);
		fetch(`/api/chats/${encodeURIComponent(chatId)}/highlights`, { cache: "no-store" })
			.then((res) => (res.ok ? res.json() : null))
			.then((body: { highlights?: ChatHighlight[] } | null) => {
				if (!cancelled && Array.isArray(body?.highlights)) setHighlights(body.highlights);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [chatId]);

	useEffect(() => {
		const scope = scopeRef.current;
		if (!scope) return;
		let frame: number | null = null;
		const sync = () => {
			frame = null;
			activeRangesRef.current = publishHighlightRanges(scope, highlights);
		};
		sync();
		const schedule = () => {
			if (frame !== null) return;
			frame = window.requestAnimationFrame(sync);
		};
		const observer = new MutationObserver(schedule);
		observer.observe(scope, { subtree: true, childList: true, characterData: true });
		return () => {
			observer.disconnect();
			if (frame !== null) window.cancelAnimationFrame(frame);
			clearUserHighlights();
		};
	}, [highlights, scopeRef]);

	const addHighlight = useCallback(
		async (input: CreateHighlightInput): Promise<ChatHighlight | null> => {
			const tempId = `temp_hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
			const optimistic: ChatHighlight = {
				id: tempId,
				...input,
				createdAt: new Date().toISOString(),
			};
			setHighlights((prev) => [...prev, optimistic]);
			try {
				const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/highlights`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(input),
				});
				if (!res.ok) {
					setHighlights((prev) => prev.filter((h) => h.id !== tempId));
					return null;
				}
				const data = (await res.json()) as { highlight: ChatHighlight };
				setHighlights((prev) => prev.map((h) => (h.id === tempId ? data.highlight : h)));
				return data.highlight;
			} catch {
				setHighlights((prev) => prev.filter((h) => h.id !== tempId));
				return null;
			}
		},
		[chatId],
	);

	const recolorHighlight = useCallback(
		async (highlightId: string, color: HighlightColor): Promise<void> => {
			setHighlights((prev) => prev.map((h) => (h.id === highlightId ? { ...h, color } : h)));
			setPopover((prev) => (prev?.highlight.id === highlightId ? { ...prev, highlight: { ...prev.highlight, color } } : prev));
			try {
				await fetch(`/api/chats/${encodeURIComponent(chatId)}/highlights`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ highlightId, color }),
				});
			} catch {
				// Best effort; optimistic state stays
			}
		},
		[chatId],
	);

	const removeHighlight = useCallback(
		async (highlightId: string): Promise<void> => {
			setHighlights((prev) => prev.filter((h) => h.id !== highlightId));
			setPopover((prev) => (prev?.highlight.id === highlightId ? null : prev));
			try {
				await fetch(
					`/api/chats/${encodeURIComponent(chatId)}/highlights?highlightId=${encodeURIComponent(highlightId)}`,
					{ method: "DELETE" },
				);
			} catch {
				// Best effort
			}
		},
		[chatId],
	);

	const jumpToHighlight = useCallback(
		(highlight: ChatHighlight) => {
			const scope = scopeRef.current;
			if (!scope) return;
			if (highlight.sourceKind === "side") {
				sideStore?.setOpen(highlight.sourceId, true);
			}
			let attempts = 0;
			const tryScroll = () => {
				const range = resolveHighlightRange(scope, highlight);
				if (range) {
					scrollSessionTarget(range, scope, scrollContextRef.current);
					return;
				}
				if (++attempts < 8) window.requestAnimationFrame(tryScroll);
			};
			window.requestAnimationFrame(tryScroll);
		},
		[scopeRef, scrollContextRef, sideStore],
	);

	// Click-to-manage popover: hit-test active highlight ranges on plain clicks.
	useEffect(() => {
		const scope = scopeRef.current;
		if (!scope) return;
		const onClick = (event: MouseEvent) => {
			const target = event.target as Element | null;
			if (popoverRef.current?.contains(target)) return;
			const sel = typeof window.getSelection === "function" ? window.getSelection() : null;
			if (sel && !sel.isCollapsed) {
				setPopover(null);
				return;
			}
			if (target?.closest("button, a, input, textarea, select, [role=button]")) {
				setPopover(null);
				return;
			}
			if (!scope.contains(target)) {
				setPopover(null);
				return;
			}
			const x = event.clientX;
			const y = event.clientY;
			// Walk backwards so later/innermost highlights win if overlapping.
			for (let i = activeRangesRef.current.length - 1; i >= 0; i--) {
				const { highlight, range } = activeRangesRef.current[i]!;
				const rects = Array.from(range.getClientRects());
				const hit = rects.some(
					(r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2,
				);
				if (hit) {
					setPopover({ highlight, x, y });
					return;
				}
			}
			setPopover(null);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setPopover(null);
		};
		const onScroll = () => setPopover(null);
		document.addEventListener("click", onClick);
		document.addEventListener("keydown", onKeyDown);
		window.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("click", onClick);
			document.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [scopeRef]);

	const value = useMemo<ChatHighlightsContextValue>(
		() => ({ highlights, addHighlight, recolorHighlight, removeHighlight, jumpToHighlight }),
		[highlights, addHighlight, recolorHighlight, removeHighlight, jumpToHighlight],
	);

	return (
		<ChatHighlightsContext.Provider value={value}>
			{children}
			{popover &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						ref={popoverRef}
						data-testid="highlight-popover"
						role="toolbar"
						aria-label="Highlight options"
						style={{
							position: "fixed",
							left: Math.max(8, Math.min(popover.x - 64, window.innerWidth - 156)),
							top: Math.max(8, Math.min(popover.y + 10, window.innerHeight - 44)),
						}}
						className="z-[110] flex items-center gap-1.5 rounded-full border bg-popover px-2 py-1 shadow-md"
					>
						{HIGHLIGHT_COLORS.map((color) => {
							const active = popover.highlight.color === color;
							return (
								<button
									key={color}
									type="button"
									data-testid={`highlight-popover-${color}`}
									aria-label={`Change highlight to ${HIGHLIGHT_SWATCH_CSS[color].label}`}
									aria-pressed={active}
									onClick={() => void recolorHighlight(popover.highlight.id, color)}
									className={`size-4 rounded-full transition-transform hover:scale-110 ${active ? "ring-2 ring-foreground ring-offset-1 ring-offset-popover" : ""}`}
									style={{ backgroundColor: HIGHLIGHT_SWATCH_CSS[color].dot }}
								/>
							);
						})}
						<div className="mx-0.5 h-3.5 w-px bg-border" aria-hidden />
						<button
							type="button"
							data-testid="highlight-popover-delete"
							aria-label="Remove highlight"
							title="Remove highlight"
							onClick={() => void removeHighlight(popover.highlight.id)}
							className="flex size-5 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
						>
							<Trash2Icon className="size-3.5" />
						</button>
					</div>,
					document.body,
				)}
		</ChatHighlightsContext.Provider>
	);
}
