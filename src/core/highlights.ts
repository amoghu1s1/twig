import { CITATION_CONTEXT_LENGTH, CITATION_MAX_TEXT_LENGTH, type TextSelector } from "./citations.ts";

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export interface ChatHighlight {
	id: string;
	sourceKind: "tutor" | "side";
	/** Native messageId for tutor prose, or sideChat threadId for side answers. */
	sourceId: string;
	/** SideChatMessage.id when sourceKind === "side". */
	sideMessageId?: string;
	selector: TextSelector;
	color: HighlightColor;
	createdAt: string;
}

export class HighlightInputError extends Error {}

const MAX_ID_LENGTH = 512;

export function newHighlightId(): string {
	return `hl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function isHighlightColor(value: unknown): value is HighlightColor {
	return typeof value === "string" && (HIGHLIGHT_COLORS as readonly string[]).includes(value);
}

function parseSelector(raw: unknown): TextSelector {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new HighlightInputError("selector must be an object");
	}
	const s = raw as Record<string, unknown>;
	if (typeof s.text !== "string" || !s.text.trim() || s.text.length > CITATION_MAX_TEXT_LENGTH) {
		throw new HighlightInputError("selector.text must be a non-empty string");
	}
	if (typeof s.start !== "number" || !Number.isSafeInteger(s.start) || s.start < 0) {
		throw new HighlightInputError("selector.start must be a non-negative integer");
	}
	if (typeof s.end !== "number" || !Number.isSafeInteger(s.end) || s.end <= s.start) {
		throw new HighlightInputError("selector.end must be an integer greater than start");
	}
	if (typeof s.prefix !== "string" || s.prefix.length > CITATION_CONTEXT_LENGTH) {
		throw new HighlightInputError("selector.prefix is invalid");
	}
	if (typeof s.suffix !== "string" || s.suffix.length > CITATION_CONTEXT_LENGTH) {
		throw new HighlightInputError("selector.suffix is invalid");
	}
	return {
		text: s.text,
		start: s.start,
		end: s.end,
		prefix: s.prefix,
		suffix: s.suffix,
	};
}

export interface CreateHighlightInput {
	sourceKind: "tutor" | "side";
	sourceId: string;
	sideMessageId?: string;
	selector: TextSelector;
	color: HighlightColor;
}

export function parseHighlightCreate(raw: unknown): CreateHighlightInput {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new HighlightInputError("body must be an object");
	}
	const body = raw as Record<string, unknown>;
	if (body.sourceKind !== "tutor" && body.sourceKind !== "side") {
		throw new HighlightInputError('sourceKind must be "tutor" or "side"');
	}
	if (typeof body.sourceId !== "string" || !body.sourceId.trim() || body.sourceId.length > MAX_ID_LENGTH) {
		throw new HighlightInputError("sourceId must be a non-empty string");
	}
	let sideMessageId: string | undefined;
	if (body.sourceKind === "side") {
		if (typeof body.sideMessageId !== "string" || !body.sideMessageId.trim() || body.sideMessageId.length > MAX_ID_LENGTH) {
			throw new HighlightInputError("sideMessageId is required for side highlights");
		}
		sideMessageId = body.sideMessageId;
	}
	if (!isHighlightColor(body.color)) {
		throw new HighlightInputError("color must be yellow, green, blue, or pink");
	}
	return {
		sourceKind: body.sourceKind,
		sourceId: body.sourceId,
		...(sideMessageId ? { sideMessageId } : {}),
		selector: parseSelector(body.selector),
		color: body.color,
	};
}

export interface UpdateHighlightInput {
	highlightId: string;
	color: HighlightColor;
}

export function parseHighlightUpdate(raw: unknown): UpdateHighlightInput {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new HighlightInputError("body must be an object");
	}
	const body = raw as Record<string, unknown>;
	if (typeof body.highlightId !== "string" || !body.highlightId.trim() || body.highlightId.length > MAX_ID_LENGTH) {
		throw new HighlightInputError("highlightId must be a non-empty string");
	}
	if (!isHighlightColor(body.color)) {
		throw new HighlightInputError("color must be yellow, green, blue, or pink");
	}
	return {
		highlightId: body.highlightId,
		color: body.color,
	};
}
