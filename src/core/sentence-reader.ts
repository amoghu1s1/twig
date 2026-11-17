/**
 * Sentence reader pure layer (owner, 2026-10-21): turns the teacher's
 * Markdown into reveal steps (one sentence each), derives the plain text to
 * speak for a step, and parses the learner's reader preferences. No DOM.
 */
import { DEFAULT_TTS_VOICE, TTS_RATE_MAX, TTS_RATE_MIN, TTS_VOICES } from "./tts.ts";
import type { LhViewMessage } from "./view.ts";

export interface ReaderUnit {
	/** Markdown of this step, rendered on its own. */
	markdown: string;
	/** Sentences of one paragraph flow inline; every other step is a block. */
	inline: boolean;
	/** True for the first step of a paragraph/block (starts a new line). */
	startsBlock: boolean;
	/** 0-based list nesting depth when this step is a list item. */
	listDepth?: number;
	/** True when this list item continues the same list as the previous step. */
	listContinuation?: boolean;
}

const FENCE = /^\s*(```|~~~)/;
const QUOTE_MARKER = /^\s*>/;
const LIST_ITEM_RE = /^([ \t]*)([-*+•◦▪]|\d+[.)])(?:[ \t]+(.*)|[ \t]*)$/;
const HEADING_OR_RULE_RE = /^\s*(?:#{1,6}\s|([-*_])\1{2,}\s*$|\|)/;
const BLOCK_MARKER = /^\s*(?:#{1,6}\s|[-*+•◦▪](?:\s|$)|\d+[.)](?:\s|$)|>|\|)/;
const HORIZONTAL_RULE_RE = /^\s*([-*_])\1{2,}\s*$/;

const UNICODE_BULLETS = new Set(["•", "◦", "▪"]);

/** Abbreviations that usually sit mid-sentence before a name, number, or clause. */
const ALWAYS_MID_ABBREV = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Rev|Gen|Col|Capt|Lt|Sgt|vs|e\.g|i\.e|et\s+al|Fig|Figs|Eq|Eqs|eq|Sec|sec|Ch|ch|Vol|vol|No|no|pp?|approx|est|cf|resp|incl)\.$/i;
const CONTEXTUAL_MID_ABBREV = /\b(?:etc)\.$/i;

function unquoteLine(line: string): string {
	return line.replace(/^\s*(?:>\s*)*/, "").trim();
}

function leadingColumns(line: string): number {
	let cols = 0;
	for (const ch of line) {
		if (ch === " ") cols += 1;
		else if (ch === "\t") cols += 4 - (cols % 4);
		else break;
	}
	return cols;
}

/** Strip at most `cols` columns of leading whitespace (expanding tabs cleanly). */
function stripIndentColumns(line: string, cols: number): string {
	if (cols <= 0) return line;
	let dropped = 0;
	let i = 0;
	while (i < line.length && dropped < cols) {
		const ch = line[i]!;
		if (ch === " ") {
			dropped += 1;
			i++;
		} else if (ch === "\t") {
			const step = 4 - (dropped % 4);
			if (dropped + step <= cols) {
				dropped += step;
				i++;
			} else {
				const rem = dropped + step - cols;
				return " ".repeat(rem) + line.slice(i + 1);
			}
		} else {
			break;
		}
	}
	return line.slice(i);
}

function detectMathOpen(trimmed: string): "$$" | "\\]" | null {
	const dollars = trimmed.split("$$").length - 1;
	if (trimmed.startsWith("$$") && dollars % 2 === 1) return "$$";
	if (trimmed.startsWith("\\[") && !trimmed.includes("\\]")) return "\\]";
	return null;
}

function isEscapedAt(text: string, idx: number): boolean {
	let backslashes = 0;
	for (let i = idx - 1; i >= 0 && text[i] === "\\"; i--) backslashes++;
	return backslashes % 2 === 1;
}

function matchBacktickSpan(text: string, start: number): number {
	let ticks = 0;
	while (text[start + ticks] === "`") ticks++;
	let i = start + ticks;
	while (i < text.length) {
		if (text[i] === "\n") return -1;
		if (text[i] === "`") {
			let run = 0;
			while (text[i + run] === "`") run++;
			if (run === ticks) return i + run;
			i += run;
			continue;
		}
		i++;
	}
	return -1;
}

function matchDelimited(text: string, start: number, close: string, singleLine: boolean): number {
	let i = start;
	while (i < text.length) {
		if (singleLine && text[i] === "\n") return -1;
		if (text.startsWith(close, i) && !isEscapedAt(text, i)) return i + close.length;
		i++;
	}
	return -1;
}

function matchMarkdownLink(text: string, start: number): number {
	let i = start;
	if (text[i] === "!") i++;
	if (text[i] !== "[") return -1;
	i++;
	let depth = 1;
	while (i < text.length && depth > 0) {
		if (text[i] === "\n") return -1;
		if (!isEscapedAt(text, i)) {
			if (text[i] === "[") depth++;
			else if (text[i] === "]") depth--;
		}
		i++;
	}
	if (depth !== 0 || text[i] !== "(") return -1;
	i++;
	let parenDepth = 1;
	while (i < text.length && parenDepth > 0) {
		if (text[i] === "\n") return -1;
		if (!isEscapedAt(text, i)) {
			if (text[i] === "(") parenDepth++;
			else if (text[i] === ")") parenDepth--;
		}
		i++;
	}
	return parenDepth === 0 ? i : -1;
}

/** Replace spans a sentence break must never land in (math, code, links, URLs)
 *  with placeholders; returns the masked text and a restore function. */
function maskSpans(text: string): { masked: string; restore: (s: string) => string } {
	const spans: string[] = [];
	const pushSpan = (raw: string) => {
		spans.push(raw);
		return `\u0000${spans.length - 1}\u0000`;
	};
	let out = "";
	let i = 0;
	while (i < text.length) {
		if (text[i] === "`") {
			const end = matchBacktickSpan(text, i);
			if (end !== -1) {
				out += pushSpan(text.slice(i, end));
				i = end;
				continue;
			}
		} else if (text.startsWith("$$", i) && !isEscapedAt(text, i)) {
			const end = matchDelimited(text, i + 2, "$$", false);
			if (end !== -1) {
				out += pushSpan(text.slice(i, end));
				i = end;
				continue;
			}
		} else if (text.startsWith("\\[", i) && !isEscapedAt(text, i)) {
			const end = matchDelimited(text, i + 2, "\\]", false);
			if (end !== -1) {
				out += pushSpan(text.slice(i, end));
				i = end;
				continue;
			}
		} else if (text.startsWith("\\(", i) && !isEscapedAt(text, i)) {
			const end = matchDelimited(text, i + 2, "\\)", false);
			if (end !== -1) {
				out += pushSpan(text.slice(i, end));
				i = end;
				continue;
			}
		} else if (text[i] === "$" && !isEscapedAt(text, i)) {
			const end = matchDelimited(text, i + 1, "$", true);
			if (end !== -1 && end > i + 2) {
				out += pushSpan(text.slice(i, end));
				i = end;
				continue;
			}
		} else if ((text[i] === "[" || text.startsWith("![", i)) && !isEscapedAt(text, i)) {
			const end = matchMarkdownLink(text, i);
			if (end !== -1) {
				out += pushSpan(text.slice(i, end));
				i = end;
				continue;
			}
		} else if (text.startsWith("http://", i) || text.startsWith("https://", i)) {
			const urlMatch = /^https?:\/\/[^\s<>()]+/.exec(text.slice(i));
			if (urlMatch) {
				const raw = urlMatch[0].replace(/[.,!?;:'")]+$/, "");
				if (raw.length > "https://".length) {
					out += pushSpan(raw);
					i += raw.length;
					continue;
				}
			}
		}
		out += text[i]!;
		i++;
	}
	return { masked: out, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, idx) => spans[Number(idx)] ?? "") };
}

function shouldMergeSegments(prev: string, next: string): boolean {
	if (/^\d+[.)]$/.test(next)) return true;
	if (ALWAYS_MID_ABBREV.test(prev)) return true;
	if (CONTEXTUAL_MID_ABBREV.test(prev) && /^[a-z0-9,(]/.test(next)) return true;
	return false;
}

const EMPHASIS_MARKERS = ["**", "__", "~~", "*", "_"] as const;

function updateEmphasisStack(text: string, stack: string[]): void {
	let i = 0;
	while (i < text.length) {
		if (text[i] === "\\" || text[i] === "\u0000") {
			if (text[i] === "\\") i += 2;
			else {
				const close = text.indexOf("\u0000", i + 1);
				i = close === -1 ? i + 1 : close + 1;
			}
			continue;
		}
		const marker = EMPHASIS_MARKERS.find((m) => text.startsWith(m, i));
		if (!marker) {
			i++;
			continue;
		}
		// Avoid treating word-internal underscores (snake_case) as emphasis toggles.
		if (marker === "_" && i > 0 && /\w/.test(text[i - 1]!) && i + 1 < text.length && /\w/.test(text[i + 1]!)) {
			i++;
			continue;
		}
		if (stack.length > 0 && stack[stack.length - 1] === marker) {
			stack.pop();
		} else {
			stack.push(marker);
		}
		i += marker.length;
	}
}

/** Balance inline emphasis delimiters (`**`, `__`, `~~`, `*`, `_`) across
 *  sentence breaks so bold/italic spans keep their styling per step. */
function balanceEmphasisAcrossSegments(segments: string[]): string[] {
	const stack: string[] = [];
	const balanced: string[] = [];
	for (const rawSeg of segments) {
		let seg = rawSeg;
		// Strip a leading closing marker left behind when a break landed right before `**` / `*`.
		while (stack.length > 0) {
			const top = stack[stack.length - 1]!;
			if (seg.startsWith(top) && (seg.length === top.length || /\s/.test(seg[top.length]!))) {
				stack.pop();
				seg = seg.slice(top.length).trimStart();
			} else {
				break;
			}
		}
		if (seg === "") continue;
		const prefix = stack.join("");
		updateEmphasisStack(seg, stack);
		const suffix = [...stack].reverse().join("");
		balanced.push(`${prefix}${seg}${suffix}`);
	}
	return balanced;
}

/** Prevent CommonMark from interpreting an inline sentence fragment (like `"2."`
 *  or `"1998."`) as a block-level list item or heading. */
function guardInlineBlockSyntax(markdown: string): string {
	return markdown.replace(/^(\s*\d+)([.)])(\s|$)/, "$1\\$2$3").replace(/^(\s*)([-*+]|#{1,6})(\s)/, "$1\\$2$3");
}

function segmentSentences(paragraph: string): string[] {
	const { masked, restore } = maskSpans(paragraph);
	const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
	const raw: string[] = [];
	for (const { segment } of segmenter.segment(masked)) {
		const s = segment.trim();
		if (s !== "") raw.push(s);
	}
	const merged: string[] = [];
	for (const seg of raw) {
		const prev = merged[merged.length - 1];
		if (prev !== undefined && shouldMergeSegments(prev, seg)) {
			merged[merged.length - 1] = `${prev} ${seg}`;
		} else {
			merged.push(seg);
		}
	}
	return balanceEmphasisAcrossSegments(merged)
		.map((seg) => guardInlineBlockSyntax(restore(seg).trim()))
		.filter((s) => s !== "");
}

/** Split Markdown into blocks: top-level fenced code and `$$` / `\[` display math
 *  stay whole; everything else breaks at blank lines (keeping quote/callout lines
 *  and indented list continuations attached to their block). */
function splitBlocks(markdown: string): { text: string; atomic: boolean }[] {
	const rawLines = markdown.split("\n");
	const blocks: { text: string; atomic: boolean }[] = [];
	let buf: string[] = [];
	let fence: string | null = null;
	let fenceContained = false;
	let inMath: "$$" | "\\]" | null = null;
	let mathContained = false;
	let listContentIndent: number | null = null;
	const flush = (atomic: boolean) => {
		// Trim only outer blank lines so leading list/continuation indent is preserved.
		while (buf.length > 0 && buf[0]!.trim() === "") buf.shift();
		while (buf.length > 0 && buf[buf.length - 1]!.trim() === "") buf.pop();
		const text = buf.join("\n");
		if (text.trim() !== "") blocks.push({ text, atomic });
		buf = [];
		listContentIndent = null;
	};
	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i]!;
		const unquoted = unquoteLine(line);
		if (fence !== null) {
			buf.push(line);
			if (unquoted.startsWith(fence)) {
				fence = null;
				if (!fenceContained) flush(true);
				fenceContained = false;
			}
			continue;
		}
		if (inMath !== null) {
			buf.push(line);
			if (line.includes(inMath)) {
				inMath = null;
				if (!mathContained) flush(true);
				mathContained = false;
			}
			continue;
		}
		const isQuote = QUOTE_MARKER.test(line);
		const cols = leadingColumns(line);
		const inListContinuation = listContentIndent !== null && cols >= listContentIndent;
		const contained = isQuote || inListContinuation;
		const f = FENCE.exec(unquoted);
		if (f) {
			if (!contained) flush(false);
			fence = f[1] ?? "```";
			fenceContained = contained;
			buf.push(line);
			continue;
		}
		const mathOpen = detectMathOpen(unquoted);
		if (mathOpen !== null) {
			if (!contained) flush(false);
			inMath = mathOpen;
			mathContained = contained;
			buf.push(line);
			continue;
		}
		if (line.trim() === "") {
			if (listContentIndent !== null) {
				let nextIdx = i + 1;
				while (nextIdx < rawLines.length && rawLines[nextIdx]!.trim() === "") nextIdx++;
				const next = rawLines[nextIdx];
				if (next !== undefined && !LIST_ITEM_RE.test(next) && leadingColumns(next) >= listContentIndent) {
					buf.push(line);
					continue;
				}
			}
			flush(false);
			continue;
		}
		const listMatch = LIST_ITEM_RE.exec(line);
		if (listMatch) {
			listContentIndent = leadingColumns(line) + listMatch[2]!.length + 1;
		} else if (!isQuote && listContentIndent !== null && cols < listContentIndent) {
			listContentIndent = null;
		}
		buf.push(line);
	}
	flush((fence !== null && !fenceContained) || (inMath !== null && !mathContained));
	return blocks;
}

function isTable(text: string): boolean {
	const lines = text.split("\n");
	return lines.length >= 2 && lines[0]!.includes("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1]!) && lines[1]!.includes("-");
}

function normalizeListItemMarkdown(lines: string[], indent: number, marker: string): string {
	const dedented = lines.map((line) => (line.trim() === "" ? "" : stripIndentColumns(line, indent)));
	if (UNICODE_BULLETS.has(marker)) {
		dedented[0] = dedented[0]!.replace(marker, "-");
	}
	return dedented.join("\n").trim();
}

/** The reveal steps of a Markdown passage. */
export function splitReaderUnits(markdown: string): ReaderUnit[] {
	const units: ReaderUnit[] = [];
	let indentStack: number[] = [];
	let prevWasListItem = false;
	const resetList = () => {
		indentStack = [];
		prevWasListItem = false;
	};
	const pushProse = (lines: string[]) => {
		if (lines.length === 0) return;
		resetList();
		const sentences = segmentSentences(lines.join(" "));
		sentences.forEach((s, i) => units.push({ markdown: s, inline: true, startsBlock: i === 0 }));
	};

	for (const block of splitBlocks(markdown)) {
		if (block.atomic || isTable(block.text) || HORIZONTAL_RULE_RE.test(block.text)) {
			resetList();
			units.push({ markdown: block.text, inline: false, startsBlock: true });
			continue;
		}
		const lines = block.text.split("\n");
		if (lines.some((l) => BLOCK_MARKER.test(l))) {
			// Headings, blockquotes, and list items become block steps; plain prose
			// lines inside a mixed block still segment sentence-by-sentence.
			type ChunkKind = "prose" | "quote" | "item" | "heading";
			let kind: ChunkKind | null = null;
			let current: string[] = [];
			let itemIndent = 0;
			let itemMarker = "";
			let inFence: string | null = null;
			let inMath: "$$" | "\\]" | null = null;

			const flushChunk = () => {
				if (current.length === 0 || kind === null) return;
				if (kind === "prose") {
					pushProse(current);
				} else if (kind === "item") {
					while (indentStack.length > 0 && indentStack[indentStack.length - 1]! > itemIndent) {
						indentStack.pop();
					}
					if (indentStack.length === 0 || indentStack[indentStack.length - 1]! < itemIndent) {
						indentStack.push(itemIndent);
					}
					const listDepth = indentStack.length - 1;
					units.push({
						markdown: normalizeListItemMarkdown(current, itemIndent, itemMarker),
						inline: false,
						startsBlock: true,
						listDepth,
						...(prevWasListItem ? { listContinuation: true } : {}),
					});
					prevWasListItem = true;
				} else {
					resetList();
					units.push({ markdown: current.join("\n"), inline: false, startsBlock: true });
				}
				current = [];
				kind = null;
			};

			for (const line of lines) {
				const unquoted = unquoteLine(line);
				if (inFence !== null) {
					current.push(line);
					if (unquoted.startsWith(inFence)) inFence = null;
					continue;
				}
				if (inMath !== null) {
					current.push(line);
					if (line.includes(inMath)) inMath = null;
					continue;
				}
				const isQuote = QUOTE_MARKER.test(line);
				const listMatch = !isQuote ? LIST_ITEM_RE.exec(line) : null;
				const isHeadingOrRule = !isQuote && !listMatch && (HEADING_OR_RULE_RE.test(line) || HORIZONTAL_RULE_RE.test(line));

				if (isQuote) {
					if (kind !== "quote") {
						flushChunk();
						kind = "quote";
					}
				} else if (listMatch) {
					flushChunk();
					kind = "item";
					itemIndent = leadingColumns(line);
					itemMarker = listMatch[2]!;
				} else if (isHeadingOrRule) {
					flushChunk();
					kind = "heading";
				} else if (kind === null || kind === "heading" || kind === "quote") {
					flushChunk();
					kind = "prose";
				}
				// Plain or blank continuation lines inside `kind === "item"` stay attached to that item.
				current.push(line);
				const f = FENCE.exec(unquoted);
				if (f) inFence = f[1] ?? "```";
				else inMath = detectMathOpen(unquoted);
			}
			flushChunk();
			continue;
		}
		pushProse(lines);
	}
	return units;
}

/** Plain text to speak for one step: Markdown syntax stripped, math and code
 *  spoken as a short placeholder, so the voice never reads `$\frac{a}{b}$`. */
export function speechText(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?```/g, " code block ")
		.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]/g, " formula ")
		.replace(/\$[^$\n]+?\$|\\\([\s\S]+?\\\)/g, " formula ")
		.replace(/`([^`\n]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s*(?:>\s*)?\[!(?:note|tip|important|warning|caution)\][ \t]*$/gim, "")
		.replace(/^\s*(?:#{1,6}\s+|(?:>\s*)+|[-*+•◦▪]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, "")
		.replace(/\\([.)\-*+#])/g, "$1")
		.replace(/(\*\*|__|\*|~~)|(?<!\w)_|_(?!\w)/g, "")
		.replace(/\|/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export type RevealStyle = "blur" | "hide" | "dim";

export interface ReaderPrefs {
	style: RevealStyle;
	/** Prose font size in px. */
	fontSize: number;
	/** Read each sentence aloud as it is revealed. */
	autoRead: boolean;
	voice: string;
	/** Speaking speed (ElevenLabs 0.7–1.2). */
	rate: number;
	/** Opt-in: speak through the ElevenLabs proxy (POST /api/tts). DEFAULT OFF —
	 *  the browser's built-in voice is the default (privacy + zero cost). */
	cloud: boolean;
}

export const READER_PREFS_KEY = "lh-reader";
export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 32;

export const DEFAULT_READER_PREFS: ReaderPrefs = { style: "blur", fontSize: 20, autoRead: false, voice: DEFAULT_TTS_VOICE, rate: 1, cloud: false };

/** Parse the stored preferences, falling back per field to the defaults. */
export function parseReaderPrefs(raw: string | null): ReaderPrefs {
	const d = DEFAULT_READER_PREFS;
	let o: Record<string, unknown> = {};
	try {
		const v: unknown = raw === null ? {} : JSON.parse(raw);
		if (v !== null && typeof v === "object" && !Array.isArray(v)) o = v as Record<string, unknown>;
	} catch {
		// Corrupt storage: defaults.
	}
	const num = (x: unknown, lo: number, hi: number, fallback: number) =>
		typeof x === "number" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
	return {
		style: o.style === "blur" || o.style === "hide" || o.style === "dim" ? o.style : d.style,
		fontSize: Math.round(num(o.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX, d.fontSize)),
		autoRead: typeof o.autoRead === "boolean" ? o.autoRead : d.autoRead,
		voice: typeof o.voice === "string" && TTS_VOICES.some(([id]) => id === o.voice) ? o.voice : d.voice,
		rate: num(o.rate, TTS_RATE_MIN, TTS_RATE_MAX, d.rate),
		cloud: typeof o.cloud === "boolean" ? o.cloud : d.cloud,
	};
}

export interface ReaderPassageTarget {
	text: string;
	partId?: string;
}

function fnv1aHex(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic sessionStorage key for a passage's reading position. */
export function readerPassageKey(text: string, partId?: string): string {
	const id = partId?.trim();
	return `lh-reader-pos:${id ? id : fnv1aHex(text)}`;
}

/** Clamp a restored step index against a passage's current step count. */
export function clampReaderStep(saved: number | null | undefined, total: number): number {
	if (total <= 0) return 0;
	if (typeof saved !== "number" || !Number.isFinite(saved) || saved < 1) return 1;
	return Math.min(total, Math.round(saved));
}

/**
 * The passage (with its part id, when settled) the reader shortcut opens
 * (owner, 2026-10-29): the newest teacher text that is non-empty and
 * finished — the same rule that shows the "Read by sentence" button. While
 * a turn streams, the passage still being written is not readable, and an
 * older one is not offered in its place.
 */
export function latestReadablePassageTarget(messages: readonly LhViewMessage[], streaming: boolean): ReaderPassageTarget | null {
	for (let mi = messages.length - 1; mi >= 0; mi--) {
		const message = messages[mi]!;
		if (message.role !== "assistant") continue;
		for (let pi = message.parts.length - 1; pi >= 0; pi--) {
			const part = message.parts[pi]!;
			if (part.type !== "text" || (part.text ?? "").trim() === "") continue;
			const stillWriting = streaming && mi === messages.length - 1 && pi === message.parts.length - 1;
			if (stillWriting) return null;
			return {
				text: part.text ?? "",
				...(typeof part.id === "string" && part.id !== "" ? { partId: part.id } : {}),
			};
		}
	}
	return null;
}

/** Plain text of the passage opened by the reader shortcut, or null. */
export function latestReadablePassage(messages: readonly LhViewMessage[], streaming: boolean): string | null {
	return latestReadablePassageTarget(messages, streaming)?.text ?? null;
}
