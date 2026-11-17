"use client";

/**
 * The sentence reader (owner, 2026-10-21): a full-screen overlay that
 * reveals one passage of the teacher's prose a sentence at a time, with
 * optional read-aloud. Read-aloud defaults to the browser's built-in voice;
 * ElevenLabs is opt-in (prefs.cloud) and rides POST /api/tts through the
 * server. Each step is rendered from Markdown on its own (nothing in the
 * transcript's DOM is touched); progress is not saved.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { parseMarkdownIntoBlocks } from "streamdown";
import { BookOpenTextIcon, CloudIcon, MessageCircleQuestionIcon, MessagesSquareIcon, RotateCcwIcon, Volume2Icon, VolumeXIcon, XIcon } from "lucide-react";
import { AssistantTextResponse } from "@/components/ai-elements/message";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { ReaderSpeaker } from "@/components/reader-speaker";
import { DiscussPanel, PassageAsk, useDiscuss } from "@/components/readings/discussion";
import { SideChatWindow } from "@/components/side-chat";
import { sideBlockKey, useSideChatStore, useSideWindows, type SideChatStore } from "@/components/side-chat-state";
import {
	clampReaderStep,
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	healOverescapedCommands,
	parseReaderPrefs,
	READER_PREFS_KEY,
	readerPassageKey,
	speechText,
	splitReaderUnits,
	transformMathDelimiters,
	TTS_RATE_MAX,
	TTS_RATE_MIN,
	TTS_VOICES,
	type ReaderPrefs,
	type ReaderUnit,
	type RevealStyle,
	type SideChatAnchor,
} from "@/src/core";

const STYLE_LABEL: Record<RevealStyle, string> = { blur: "Blur", hide: "Hide", dim: "Dim" };

function loadPrefs(): ReaderPrefs {
	try {
		return parseReaderPrefs(localStorage.getItem(READER_PREFS_KEY));
	} catch {
		return parseReaderPrefs(null);
	}
}

function hiddenClass(style: RevealStyle): string {
	if (style === "hide") return "opacity-0";
	if (style === "dim") return "opacity-25";
	return "opacity-40 blur-[5px]";
}

/** The reading surface's type tokens. `.lh-prose` reads these variables, so
 *  the size slider must change the TOKEN — a plain parent font-size loses to
 *  the class. Exported pure for the render test. */
export function readerFontStyle(fontSize: number): React.CSSProperties {
	return { "--lh-prose-size": `${fontSize}px`, "--lh-prose-leading": "1.9" } as React.CSSProperties;
}

export interface SentenceReaderPassage {
	messageId?: string;
	partId?: string;
	sideEnabled?: boolean;
}

const SIDE_WINDOW_FONT_STYLE = {
	"--lh-prose-size": "1.0625rem",
	"--lh-prose-leading": "1.65",
} as React.CSSProperties;

const EMPTY_BLOCK_SET = new Set<string>();

function normalizeBlockText(s: string): string {
	return s.replace(/(^|\n)([ \t]*)[•◦▪](?=\s)/g, "$1$2-").replace(/\s+/g, " ").trim();
}

function readerGroupMarginClass(unit: ReaderUnit): string {
	if (unit.listDepth === undefined) return "my-5";
	return unit.listContinuation ? "my-1.5" : "mt-5 mb-1.5";
}

export function alignReaderGroupAnchors(
	text: string,
	messageId: string,
	partId: string,
	groups: readonly number[][],
	units: readonly ReaderUnit[],
): SideChatAnchor[] {
	const blocks = parseMarkdownIntoBlocks(transformMathDelimiters(healOverescapedCommands(text)));
	let cursor = 0;
	return groups.map((group, groupIdx) => {
		const raw = group.map((i) => units[i]!.markdown).join(units[group[0]!]!.inline ? " " : "\n");
		const needle = normalizeBlockText(transformMathDelimiters(healOverescapedCommands(raw)));
		for (let b = cursor; b < blocks.length; b++) {
			const blk = blocks[b]!;
			if (!blk.trim()) continue;
			const haystack = normalizeBlockText(blk);
			if (haystack === needle || haystack.includes(needle) || needle.includes(haystack)) {
				cursor = b;
				return { messageId, partId, blockIndex: b, blockText: blk };
			}
		}
		return { messageId, partId, blockIndex: groupIdx, blockText: raw };
	});
}

function ReaderChatGroup({
	anchor,
	revealedInGroup,
	sideEnabled,
	renderWindows,
	store,
	className = "my-5",
	children,
}: {
	anchor: SideChatAnchor;
	revealedInGroup: boolean;
	sideEnabled: boolean;
	renderWindows: boolean;
	store: SideChatStore;
	className?: string;
	children: ReactNode;
}) {
	const blockKey = sideBlockKey(anchor.partId, anchor.blockIndex);
	const windows = useSideWindows(blockKey);
	useEffect(() => {
		if (!sideEnabled) return;
		const previous = store.blocks.get(blockKey);
		store.blocks.set(blockKey, anchor);
		return () => {
			if (previous) store.blocks.set(blockKey, previous);
			else if (store.blocks.get(blockKey) === anchor) store.blocks.delete(blockKey);
		};
	}, [store, blockKey, anchor, sideEnabled]);
	return (
		<div className={className}>
			<div
				data-side-block={blockKey}
				data-side-enabled={sideEnabled ? "" : undefined}
				data-source-message-id={anchor.messageId}
				className="group/sideblock relative"
			>
				{children}
				{sideEnabled && revealedInGroup && (
					<button
						type="button"
						data-testid="reader-side-ask"
						aria-label="Ask a side question about this paragraph"
						title="Ask a side question"
						onClick={(e) => {
							e.stopPropagation();
							blurAfterPointerClick(e);
							store.openAt(anchor);
						}}
						className="absolute right-0 top-0.5 z-10 flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground/80 opacity-0 shadow-xs transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/sideblock:opacity-100"
					>
						<MessageCircleQuestionIcon className="size-3.5" />
					</button>
				)}
			</div>
			{renderWindows && windows.length > 0 && (
				<div data-side-ui="" className="my-3 flex flex-col gap-2 text-sm" style={SIDE_WINDOW_FONT_STYLE}>
					{windows.map((view) => (
						<SideChatWindow key={view.renderKey} view={view} store={store} />
					))}
				</div>
			)}
		</div>
	);
}

/** The button beside a teacher passage that opens the reader. */
export function SentenceReaderButton({ onOpen }: { onOpen: () => void }) {
	return (
		<button
			type="button"
			onClick={onOpen}
			data-testid="sentence-reader-open"
			className="mb-1 inline-flex select-none items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-60 transition-opacity hover:bg-accent hover:opacity-100"
		>
			<BookOpenTextIcon className="size-3" />
			Read by sentence
		</button>
	);
}

export function SentenceReader({
	text,
	passage,
	onClose,
}: {
	text: string;
	passage?: SentenceReaderPassage;
	onClose: () => void;
}) {
	const units = useMemo(() => splitReaderUnits(text), [text]);
	const total = units.length;
	const posKey = useMemo(() => readerPassageKey(text, passage?.partId), [text, passage?.partId]);
	const [prefs, setPrefs] = useState<ReaderPrefs>(() => parseReaderPrefs(null));
	const [revealed, setRevealed] = useState(() => Math.min(1, total));
	const loadedKeyRef = useRef<string | null>(null);
	const [fallbackNote, setFallbackNote] = useState<string | null>(null);
	const [readerDiscussOpen, setReaderDiscussOpen] = useState(false);
	const readerContentRef = useRef<HTMLDivElement | null>(null);
	const speaker = useRef<ReaderSpeaker | null>(null);
	const refs = useRef<(HTMLElement | null)[]>([]);
	const sideStore = useSideChatStore();
	const readingDiscuss = useDiscuss();
	const chatSideAvailable = Boolean(sideStore && passage?.messageId && passage?.partId && passage.sideEnabled);
	const canAskSide = chatSideAvailable || readingDiscuss !== null;

	// Steps of one paragraph share a wrapper so its sentences flow inline.
	const groups = useMemo(() => {
		const out: number[][] = [];
		units.forEach((u, i) => {
			if (u.startsBlock || out.length === 0) out.push([i]);
			else out[out.length - 1]!.push(i);
		});
		return out;
	}, [units]);

	const groupAnchors = useMemo(() => {
		if (!sideStore || !passage?.messageId || !passage?.partId) return null;
		return alignReaderGroupAnchors(text, passage.messageId, passage.partId, groups, units);
	}, [sideStore, passage?.messageId, passage?.partId, text, groups, units]);

	// When several reader groups share one Streamdown block (e.g. list items),
	// render that block's side windows once right after its last revealed group.
	const renderGroupForBlock = useMemo(() => {
		const map = new Map<number, number>();
		if (!groupAnchors) return map;
		groupAnchors.forEach((anchor, gIdx) => {
			const group = groups[gIdx]!;
			const hasRevealed = group[0]! < revealed;
			if (!map.has(anchor.blockIndex) || hasRevealed) {
				map.set(anchor.blockIndex, gIdx);
			}
		});
		return map;
	}, [groupAnchors, groups, revealed]);

	// Restore & persist reading progress per passage in sessionStorage.
	useEffect(() => {
		let restored = Math.min(1, total);
		try {
			const raw = sessionStorage.getItem(posKey);
			if (raw !== null) restored = clampReaderStep(Number(raw), total);
		} catch {
			// Storage blocked: fall back to step 1.
		}
		loadedKeyRef.current = posKey;
		setRevealed(restored);
	}, [posKey, total]);

	useEffect(() => {
		if (loadedKeyRef.current !== posKey) return;
		try {
			sessionStorage.setItem(posKey, String(revealed));
		} catch {
			// Storage blocked: no-op.
		}
	}, [posKey, revealed]);

	// Auto-open the Discuss drawer when a reading passage draft is triggered inside the reader.
	const prevDraftRef = useRef(readingDiscuss?.draft ?? null);
	useEffect(() => {
		const draft = readingDiscuss?.draft ?? null;
		if (draft && draft !== prevDraftRef.current) setReaderDiscussOpen(true);
		prevDraftRef.current = draft;
	}, [readingDiscuss?.draft]);

	// Stored preferences load after mount (the overlay itself is client-only).
	useEffect(() => setPrefs(loadPrefs()), []);
	const updatePrefs = (patch: Partial<ReaderPrefs>) =>
		setPrefs((p) => {
			const next = { ...p, ...patch };
			try {
				localStorage.setItem(READER_PREFS_KEY, JSON.stringify(next));
			} catch {
				// Storage blocked: preferences last for this overlay only.
			}
			return next;
		});

	const speakAt = useCallback(
		(index: number) => {
			const unit = units[index];
			if (!unit) return;
			const s = (speaker.current ??= new ReaderSpeaker());
			const settings = { voice: prefs.voice, rate: prefs.rate, cloud: prefs.cloud };
			void s.speak(speechText(unit.markdown), settings).then(() => setFallbackNote(s.cloudFailure));
			const next = units[index + 1];
			if (next && prefs.cloud) s.prefetch(speechText(next.markdown), settings);
		},
		[units, prefs.cloud, prefs.rate, prefs.voice],
	);

	const goTo = useCallback(
		(count: number) => {
			const clamped = Math.min(Math.max(count, 0), total);
			setRevealed(clamped);
			if (prefs.autoRead && clamped > 0) speakAt(clamped - 1);
		},
		[total, prefs.autoRead, speakAt],
	);

	const restart = useCallback(() => {
		speaker.current?.stop();
		setRevealed(Math.min(1, total));
	}, [total]);

	const askAboutCurrent = useCallback(() => {
		if (!canAskSide || total === 0) return;
		const stepIdx = Math.max(0, Math.min(total - 1, revealed - 1));
		const currentMarkdown = units[stepIdx]?.markdown ?? "";
		if (chatSideAvailable && sideStore && groupAnchors) {
			const gIdx = groups.findIndex((g) => g.includes(stepIdx));
			const anchor = groupAnchors[Math.max(0, gIdx)] ?? groupAnchors[0];
			if (anchor) {
				sideStore.openAt(anchor, currentMarkdown);
				return;
			}
		}
		if (readingDiscuss) {
			readingDiscuss.setDraft({ passage: currentMarkdown });
			setReaderDiscussOpen(true);
		}
	}, [canAskSide, total, revealed, units, chatSideAvailable, sideStore, groupAnchors, groups, readingDiscuss]);

	const nextParagraph = () => {
		let j = revealed;
		while (j < total && !units[j]?.startsBlock) j++;
		goTo(j < total ? j + 1 : total);
	};
	const prevParagraph = () => {
		let start = revealed - 1;
		while (start > 0 && !units[start]?.startsBlock) start--;
		if (start === revealed - 1) {
			// Already at a paragraph's first sentence: go to the previous one.
			start--;
			while (start > 0 && !units[start]?.startsBlock) start--;
		}
		goTo(Math.max(start, 0) + 1);
	};

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const target = e.target as HTMLElement | null;
			if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
			const key = e.key;
			const lower = key.toLowerCase();
			if (key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			} else if (key === " " || key === "ArrowRight" || (lower === "j" && !e.shiftKey)) {
				e.preventDefault();
				goTo(revealed + 1);
			} else if (key === "ArrowLeft" || (lower === "k" && !e.shiftKey)) {
				e.preventDefault();
				goTo(revealed - 1);
			} else if (e.shiftKey && lower === "j") {
				e.preventDefault();
				nextParagraph();
			} else if (e.shiftKey && lower === "k") {
				e.preventDefault();
				prevParagraph();
			} else if (e.shiftKey && lower === "g") {
				e.preventDefault();
				goTo(total);
			} else if ((e.shiftKey && lower === "r") || key === "0" || key === "Home") {
				e.preventDefault();
				restart();
			} else if (canAskSide && (key === "?" || (!e.shiftKey && lower === "a"))) {
				e.preventDefault();
				askAboutCurrent();
			} else if (e.shiftKey && lower === "s") {
				e.preventDefault();
				if (prefs.autoRead) speaker.current?.stop();
				updatePrefs({ autoRead: !prefs.autoRead });
			} else if (lower === "s") {
				e.preventDefault();
				if (revealed > 0) speakAt(revealed - 1);
			} else if (lower === "c") {
				e.preventDefault();
				updatePrefs({ cloud: !prefs.cloud });
			} else if (key === "-" || key === "_") {
				e.preventDefault();
				updatePrefs({ fontSize: Math.max(FONT_SIZE_MIN, prefs.fontSize - 2) });
			} else if (key === "=" || key === "+") {
				e.preventDefault();
				updatePrefs({ fontSize: Math.min(FONT_SIZE_MAX, prefs.fontSize + 2) });
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	});

	// Follow the newest revealed step.
	useEffect(() => {
		if (revealed > 0) refs.current[revealed - 1]?.scrollIntoView({ block: "center", behavior: "smooth" });
	}, [revealed]);

	// Stop speaking when the overlay closes.
	useEffect(() => () => speaker.current?.stop(), []);

	const discussExchangeCount = readingDiscuss?.discussion
		? readingDiscuss.discussion.side.exchanges.length + readingDiscuss.discussion.threads.reduce((n, t) => n + t.exchanges.length, 0)
		: 0;

	const content = (
		<div role="dialog" aria-label="Sentence reader" data-testid="sentence-reader" className="lh-no-drag fixed inset-0 z-[90] flex flex-col bg-background text-foreground">
			<div className="lh-no-drag lh-wco-gutter flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-xs text-muted-foreground">
				<span data-testid="sentence-reader-progress" className="tabular-nums">
					{revealed} / {total}
				</span>
				<button
					type="button"
					data-testid="reader-restart"
					onClick={restart}
					disabled={revealed <= Math.min(1, total)}
					aria-label="Restart from first sentence"
					title="Restart (0 / Home)"
					className="lh-no-drag inline-flex items-center rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
				>
					<RotateCcwIcon className="size-3.5" />
				</button>
				<label className="lh-no-drag flex items-center gap-1">
					Reveal
					<select
						value={prefs.style}
						onChange={(e) => updatePrefs({ style: e.target.value as RevealStyle })}
						className="lh-no-drag rounded border border-border bg-background px-1 py-0.5"
					>
						{(Object.keys(STYLE_LABEL) as RevealStyle[]).map((s) => (
							<option key={s} value={s}>
								{STYLE_LABEL[s]}
							</option>
						))}
					</select>
				</label>
				<div className="lh-no-drag flex items-center gap-1">
					<button
						type="button"
						data-testid="sentence-reader-size-dec"
						aria-label="Decrease text size"
						title="Smaller text (-)"
						disabled={prefs.fontSize <= FONT_SIZE_MIN}
						onClick={(e) => {
							blurAfterPointerClick(e);
							updatePrefs({ fontSize: Math.max(FONT_SIZE_MIN, prefs.fontSize - 2) });
						}}
						className="lh-no-drag inline-flex size-5 items-center justify-center rounded border border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
					>
						-
					</button>
					<label className="lh-no-drag flex items-center gap-1">
						Size
						<input
							type="range"
							data-testid="sentence-reader-size"
							aria-label="Text size"
							min={FONT_SIZE_MIN}
							max={FONT_SIZE_MAX}
							value={prefs.fontSize}
							onPointerDown={(e) => e.stopPropagation()}
							onMouseDown={(e) => e.stopPropagation()}
							onChange={(e) => updatePrefs({ fontSize: Number(e.target.value) })}
							className="lh-no-drag accent-foreground"
						/>
						<span className="tabular-nums text-[11px] text-muted-foreground/80">{prefs.fontSize}px</span>
					</label>
					<button
						type="button"
						data-testid="sentence-reader-size-inc"
						aria-label="Increase text size"
						title="Larger text (+)"
						disabled={prefs.fontSize >= FONT_SIZE_MAX}
						onClick={(e) => {
							blurAfterPointerClick(e);
							updatePrefs({ fontSize: Math.min(FONT_SIZE_MAX, prefs.fontSize + 2) });
						}}
						className="lh-no-drag inline-flex size-5 items-center justify-center rounded border border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
					>
						+
					</button>
				</div>
				<button
					type="button"
					onClick={() => {
						updatePrefs({ cloud: !prefs.cloud });
					}}
					aria-pressed={prefs.cloud}
					data-testid="sentence-reader-cloud"
					className="lh-no-drag inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent"
				>
					<CloudIcon className="size-3.5" />
					Cloud voice {prefs.cloud ? "on" : "off"}
				</button>
				{prefs.cloud && (
					<>
						<label className="lh-no-drag flex items-center gap-1">
							Voice
							<select value={prefs.voice} onChange={(e) => updatePrefs({ voice: e.target.value })} className="lh-no-drag rounded border border-border bg-background px-1 py-0.5">
								{TTS_VOICES.map(([id, label]) => (
									<option key={id} value={id}>
										{label}
									</option>
								))}
							</select>
						</label>
						<label className="lh-no-drag flex items-center gap-1">
							Pace
							<input
								type="range"
								min={TTS_RATE_MIN}
								max={TTS_RATE_MAX}
								step={0.1}
								value={prefs.rate}
								onPointerDown={(e) => e.stopPropagation()}
								onMouseDown={(e) => e.stopPropagation()}
								onChange={(e) => updatePrefs({ rate: Number(e.target.value) })}
								className="lh-no-drag accent-foreground"
							/>
						</label>
					</>
				)}
				<button
					type="button"
					onClick={() => {
						if (prefs.autoRead) speaker.current?.stop();
						updatePrefs({ autoRead: !prefs.autoRead });
					}}
					aria-pressed={prefs.autoRead}
					data-testid="sentence-reader-autoread"
					className="lh-no-drag inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent"
				>
					{prefs.autoRead ? <Volume2Icon className="size-3.5" /> : <VolumeXIcon className="size-3.5" />}
					Read aloud {prefs.autoRead ? "on" : "off"}
				</button>
				{canAskSide && (
					<button
						type="button"
						data-testid="reader-ask-button"
						onClick={askAboutCurrent}
						title="Ask a side question about the current sentence (A / ?)"
						className="lh-no-drag inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
					>
						<MessageCircleQuestionIcon className="size-3.5" />
						Ask
					</button>
				)}
				{readingDiscuss !== null && (
					<button
						type="button"
						data-testid="reader-discuss-toggle"
						aria-expanded={readerDiscussOpen}
						onClick={() => setReaderDiscussOpen((v) => !v)}
						className={`lh-no-drag inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground ${
							readerDiscussOpen ? "bg-accent text-foreground" : ""
						}`}
					>
						<MessagesSquareIcon className="size-3.5" />
						Discuss
						{discussExchangeCount > 0 && <span className="tabular-nums">· {discussExchangeCount}</span>}
					</button>
				)}
				{prefs.cloud && fallbackNote !== null && (
					<span className="text-warning" title={fallbackNote} data-testid="sentence-reader-fallback">
						Using browser voice
					</span>
				)}
				<button
					type="button"
					data-testid="sentence-reader-close"
					onClick={onClose}
					aria-label="Close reader"
					className="lh-no-drag ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3.5" />
					Close
				</button>
			</div>
			<div className="flex min-h-0 flex-1">
				<div
					className="min-h-0 flex-1 overflow-y-auto"
					onClick={(e) => {
						const el = e.target as HTMLElement | null;
						if (el?.closest('[data-side-ui], [data-testid="reader-discuss-drawer"], [data-testid="discuss-thread"], [data-testid="discuss-draft"], button, a, input, textarea, select, form')) {
							return;
						}
						const sel = window.getSelection();
						if (sel && !sel.isCollapsed) return;
						goTo(revealed + 1);
					}}
				>
					{/* .lh-prose reads these variables, so the slider must set the
					    TOKEN — a plain parent font-size is overridden by the class. */}
					<div
						ref={readerContentRef}
						className="mx-auto max-w-[var(--lh-prose-width,46rem)] px-6 py-[30vh]"
						style={readerFontStyle(prefs.fontSize)}
					>
						{groups.map((group, groupIdx) => {
							const firstUnit = units[group[0]!]!;
							const groupClass = readerGroupMarginClass(firstUnit);
							const revealedInGroup = group[0]! < revealed;
							const groupMarkdown = group.map((i) => units[i]!.markdown).join(firstUnit.inline ? " " : "\n");
							const body = group.map((i) => {
								const u = units[i]!;
								const shown = i < revealed;
								const current = i === revealed - 1;
								const cls = [
									"transition-[opacity,filter] duration-200",
									u.inline ? "inline" : "block",
									u.inline && i !== group[0] ? "ml-1" : "",
									shown ? "" : hiddenClass(prefs.style),
									current ? "rounded bg-accent/60 px-0.5" : "",
								].join(" ");
								const depthAttr = u.listDepth !== undefined ? String(Math.min(u.listDepth, 2)) : undefined;
								const listStyle = u.listDepth ? { paddingLeft: `${u.listDepth * 1.5}rem` } : undefined;
								const Tag = u.inline ? "span" : "div";
								return (
									<Tag
										key={i}
										ref={(el) => {
											refs.current[i] = el;
										}}
										data-revealed={shown}
										data-list-depth={depthAttr}
										style={listStyle}
										className={cls}
									>
										<AssistantTextResponse mode="static" className={u.inline ? "inline [&_p]:inline [&>div]:inline" : ""}>
											{u.markdown}
										</AssistantTextResponse>
									</Tag>
								);
							});

							const chatAnchor = groupAnchors?.[groupIdx];
							if (sideStore && chatAnchor) {
								return (
									<ReaderChatGroup
										key={group[0]}
										anchor={chatAnchor}
										revealedInGroup={revealedInGroup}
										sideEnabled={Boolean(passage?.sideEnabled)}
										renderWindows={renderGroupForBlock.get(chatAnchor.blockIndex) === groupIdx}
										store={sideStore}
										className={groupClass}
									>
										{body}
									</ReaderChatGroup>
								);
							}

							return (
								<div key={group[0]} className={`group/sideblock relative ${groupClass}`}>
									{body}
									{readingDiscuss && revealedInGroup && (
										<button
											type="button"
											data-testid="reader-side-ask"
											aria-label="Ask a side question about this paragraph"
											title="Ask a side question"
											onClick={(e) => {
												e.stopPropagation();
												blurAfterPointerClick(e);
												readingDiscuss.setDraft({ passage: groupMarkdown });
												setReaderDiscussOpen(true);
											}}
											className="absolute right-0 top-0.5 z-10 flex size-6 items-center justify-center rounded-full bg-background/90 text-muted-foreground/80 opacity-0 shadow-xs transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/sideblock:opacity-100"
										>
											<MessageCircleQuestionIcon className="size-3.5" />
										</button>
									)}
								</div>
							);
						})}
					</div>
					{readingDiscuss && <PassageAsk rootRef={readerContentRef} />}
				</div>
				{readingDiscuss && readerDiscussOpen && (
					<aside
						data-testid="reader-discuss-drawer"
						aria-label="Discuss"
						style={SIDE_WINDOW_FONT_STYLE}
						className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-background p-4 lg:w-96"
					>
						<div className="flex items-center justify-between gap-2">
							<h2 className="flex items-center gap-1.5 font-ui text-xs uppercase tracking-widest text-muted-foreground">
								<MessagesSquareIcon className="size-3.5" /> Discuss
							</h2>
							<button
								type="button"
								aria-label="Close discuss panel"
								onClick={() => setReaderDiscussOpen(false)}
								className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								<XIcon className="size-3.5" />
							</button>
						</div>
						<DiscussPanel renderedBlocks={EMPTY_BLOCK_SET} />
					</aside>
				)}
			</div>
			<div className="border-t border-border px-4 py-1.5 text-center text-[11px] text-muted-foreground">
				Space / J / → next · K / ← back · Shift+J/K paragraph · +/- size · {canAskSide ? "A / ? side question · " : ""}C cloud voice · S speak · Shift+S auto-read · Shift+G reveal all · 0 / Shift+R restart · Esc close
			</div>
		</div>
	);
	return createPortal(content, document.body);
}
