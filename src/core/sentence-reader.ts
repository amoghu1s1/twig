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
}

const FENCE = /^\s*(```|~~~)/;
const QUOTE_MARKER = /^\s*>/;
const ITEM_MARKER = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)/;
const BLOCK_MARKER = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/;

function unquoteLine(line: string): string {
	return line.replace(/^\s*(?:>\s*)*/, "").trim();
}

function detectMathOpen(trimmed: string): "$$" | "\\]" | null {
	const dollars = trimmed.split("$$").length - 1;
	if (trimmed.startsWith("$$") && dollars % 2 === 1) return "$$";
	if (trimmed.startsWith("\\[") && !trimmed.includes("\\]")) return "\\]";
	return null;
}

/** Replace spans a sentence break must never land in (math, code) with
 *  placeholders; returns the masked text and a restore function. */
function maskSpans(text: string): { masked: string; restore: (s: string) => string } {
	const spans: string[] = [];
	const masked = text.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|`[^`\n]+`/g, (m) => {
		spans.push(m);
		return `\u0000${spans.length - 1}\u0000`;
	});
	return { masked, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => spans[Number(i)] ?? "") };
}

function segmentSentences(paragraph: string): string[] {
	const { masked, restore } = maskSpans(paragraph);
	const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
	const out: string[] = [];
	for (const { segment } of segmenter.segment(masked)) {
		const s = restore(segment).trim();
		if (s !== "") out.push(s);
	}
	return out;
}

/** Split Markdown into blocks: fenced code and `$$` / `\[` display math stay
 *  whole; everything else breaks at blank lines. Display math inside a
 *  blockquote keeps its surrounding quote/callout lines intact. */
function splitBlocks(markdown: string): { text: string; atomic: boolean }[] {
	const blocks: { text: string; atomic: boolean }[] = [];
	let buf: string[] = [];
	let fence: string | null = null;
	let fenceInQuote = false;
	let inMath: "$$" | "\\]" | null = null;
	let mathInQuote = false;
	const flush = (atomic: boolean) => {
		const text = buf.join("\n").trim();
		if (text !== "") blocks.push({ text, atomic });
		buf = [];
	};
	for (const line of markdown.split("\n")) {
		const unquoted = unquoteLine(line);
		if (fence !== null) {
			buf.push(line);
			if (unquoted.startsWith(fence)) {
				fence = null;
				if (!fenceInQuote) flush(true);
				fenceInQuote = false;
			}
			continue;
		}
		if (inMath !== null) {
			buf.push(line);
			if (line.includes(inMath)) {
				inMath = null;
				if (!mathInQuote) flush(true);
				mathInQuote = false;
			}
			continue;
		}
		const isQuote = QUOTE_MARKER.test(line);
		const f = FENCE.exec(unquoted);
		if (f) {
			if (!isQuote) flush(false);
			fence = f[1] ?? "```";
			fenceInQuote = isQuote;
			buf.push(line);
			continue;
		}
		const mathOpen = detectMathOpen(unquoted);
		if (mathOpen !== null) {
			if (!isQuote) flush(false);
			inMath = mathOpen;
			mathInQuote = isQuote;
			buf.push(line);
			continue;
		}
		if (line.trim() === "") {
			flush(false);
			continue;
		}
		buf.push(line);
	}
	flush((fence !== null && !fenceInQuote) || (inMath !== null && !mathInQuote));
	return blocks;
}

function isTable(text: string): boolean {
	const lines = text.split("\n");
	return lines.length >= 2 && lines[0]!.includes("|") && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[1]!) && lines[1]!.includes("-");
}

/** The reveal steps of a Markdown passage. */
export function splitReaderUnits(markdown: string): ReaderUnit[] {
	const units: ReaderUnit[] = [];
	for (const block of splitBlocks(markdown)) {
		if (block.atomic || isTable(block.text) || /^\s*([-*_])\1{2,}\s*$/.test(block.text)) {
			units.push({ markdown: block.text, inline: false, startsBlock: true });
			continue;
		}
		const lines = block.text.split("\n");
		if (lines.some((l) => BLOCK_MARKER.test(l))) {
			// Headings and list items become their own steps; contiguous `>`
			// blockquote lines (including GitHub callout boxes and display
			// math inside them) stay together as one unit so boxes never split.
			let current: string[] = [];
			let inQuote = false;
			let inFence: string | null = null;
			let inMath: "$$" | "\\]" | null = null;
			const push = () => {
				if (current.length > 0) units.push({ markdown: current.join("\n"), inline: false, startsBlock: true });
				current = [];
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
				const isItem = ITEM_MARKER.test(line);
				if (isQuote) {
					if (!inQuote) push();
					inQuote = true;
				} else if (isItem) {
					push();
					inQuote = false;
				}
				current.push(line);
				const f = FENCE.exec(unquoted);
				if (f) inFence = f[1] ?? "```";
				else inMath = detectMathOpen(unquoted);
			}
			push();
			continue;
		}
		const sentences = segmentSentences(lines.join(" "));
		sentences.forEach((s, i) => units.push({ markdown: s, inline: true, startsBlock: i === 0 }));
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
		.replace(/^\s*(#{1,6}\s+|(?:>\s*)+|[-*+]\s+|\d+[.)]\s+)/gm, "")
		.replace(/(\*\*|__|\*|_|~~)/g, "")
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
