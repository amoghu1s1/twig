/**
 * Readings contracts — opt-in companion documents (docs/readings.md).
 *
 * A READING is a learner-facing document the learner opts into: a primer
 * of terms before teaching, a deep dive on one idea during a lesson, a
 * recap of what a session built (with further reading), or a deep dive
 * anchored on graph propositions. Written in the background by the
 * writer sub-agent, from model knowledge or from web research with
 * verified citations.
 *
 * The doctrine fence (docs/readings.md §2): readings never steer a
 * lesson and never count as evidence of understanding. Nothing about a
 * reading reaches the graph, any assessment, or the teacher's context.
 *
 * Pure types + tiny pure helpers; type-only imports.
 */

import type { JobUsage } from "./jobs.ts";

export type ReadingKind = "primer" | "deep-dive" | "recap" | "node";
export type ReadingMode = "researched" | "model";
export type ReadingStatus = "queued" | "writing" | "ready" | "error";

export const READING_KINDS: readonly ReadingKind[] = ["primer", "deep-dive", "recap", "node"];
export const READING_MODES: readonly ReadingMode[] = ["researched", "model"];

/** The learner-facing name of each kind (one vocabulary, every surface). */
export const READING_KIND_LABEL: Readonly<Record<ReadingKind, string>> = {
	primer: "Primer",
	"deep-dive": "Deep dive",
	recap: "Recap",
	node: "Deep dive",
};

/** Owner ruling (2026-10-27): researched is the default source mode. */
export const DEFAULT_READING_MODE: ReadingMode = "researched";

/** What the reading is about / where it was asked from. */
export interface ReadingAnchor {
	/** The session it was asked from (primer, deep-dive, recap). */
	chatId?: string;
	/** Plan-tree slug a deep dive is about. */
	planNodeId?: string;
	/** The plan tree's version at request time. */
	planVersion?: number;
	/** A specific transcript message (passage deep dives). */
	messageId?: string;
	/** The selected passage text (passage deep dives). */
	passage?: string;
	/** Graph propositions it is about (node readings), frozen at creation. */
	nodeIds?: string[];
	/** Free-text topic (a primer requested before any session exists). */
	topic?: string;
	/** The teacher's suggest_reading call this reading answers, if any. */
	suggestionCallId?: string;
}

/** A proposition as the writer saw it (frozen). */
export interface ReadingProposition {
	id: string;
	name: string;
	statement: string;
}

/**
 * Everything the writer was given, frozen at creation (the practice
 * "freezes its world" law): later plan rewrites, extractions, or graph
 * deletions never shift the ground under an existing reading.
 */
export interface ReadingSnapshot {
	/** The session title, when anchored on a session. */
	sessionTitle?: string;
	/** The probe's concrete goal + strand assessment, rendered as text. */
	assessment?: string;
	/** The plan tree with derived statuses, rendered as text. */
	plan?: string;
	/** For deep dives: the anchored node's title + summary. */
	focus?: { title: string; summary?: string };
	/** For deep dives: titles of plan nodes not yet reached (the
	 *  "deeper, not further" fence — the writer may name them, never
	 *  explain them). */
	upcoming?: string[];
	/** The transcript (markdown), possibly budget-trimmed. */
	transcript?: string;
	/** True when the transcript was trimmed to the budget. */
	transcriptTrimmed?: boolean;
	/** Graph propositions (node readings; recaps: those born in the chat). */
	propositions?: ReadingProposition[];
	/** Reasoning chains among the propositions, one formatted line each. */
	chains?: string[];
}

export interface ReadingSource {
	title: string;
	url: string;
}

export interface FurtherReadingItem extends ReadingSource {
	/** One sentence: why read this, from where the lesson left off. */
	why: string;
	level?: "intro" | "standard" | "advanced";
}

export interface GlossaryTerm {
	term: string;
	definition: string;
}

export interface ReadingRecord {
	id: string;
	kind: ReadingKind;
	mode: ReadingMode;
	status: ReadingStatus;
	title: string;
	/** The learner's optional request text. */
	request?: string;
	anchor: ReadingAnchor;
	snapshot: ReadingSnapshot;
	/** Markdown + LaTeX + mermaid (the app's standard rendering contract).
	 *  Primers carry a short intro here and the glossary in `terms`. */
	body?: string;
	/** Primers: the glossary. */
	terms?: GlossaryTerm[];
	/** Sources cited in the body (researched mode only). */
	sources?: ReadingSource[];
	/** Recaps: annotated further reading, research-verified. */
	furtherReading?: FurtherReadingItem[];
	/** The latest activity line while writing ("web_fetch: …"). */
	activity?: string;
	/** Re-runs: the reading this one replaces. */
	supersedes?: string;
	error?: string;
	usage?: JobUsage;
	createdAt: string;
	updatedAt: string;
	/** Lazy v1 schema stamp (absence reads as v1). */
	version?: number;
}

/** The record format this build writes and understands. */
export const CURRENT_READING_VERSION = 1;

/** The list view's row — the record minus its heavy fields. */
export type ReadingSummary = Omit<ReadingRecord, "snapshot" | "body" | "terms" | "furtherReading" | "sources"> & {
	/** Read-time cost (server-side pricing), null when unknown. */
	costUsd?: number | null;
	/** The anchor session's current title (library rows). */
	chatTitle?: string;
};

/** POST /api/readings body. */
export interface ReadingRequest {
	kind: ReadingKind;
	mode?: ReadingMode;
	request?: string;
	chatId?: string;
	planNodeId?: string;
	messageId?: string;
	passage?: string;
	nodeIds?: string[];
	topic?: string;
	suggestionCallId?: string;
	/** Re-run: copy this reading's kind + anchor + request (mode may change). */
	rerunOf?: string;
}

/** The teacher's suggest_reading tool input (an OFFER — nothing is
 *  generated until the learner opts in). */
export interface ReadingSuggestion {
	kind: "primer" | "deep-dive" | "recap";
	planNodeId?: string;
	title: string;
	why: string;
}

/** The suggest_reading tool's name (one constant, every layer). */
export const SUGGEST_READING_TOOL = "suggest_reading";

export function isReadingKind(v: unknown): v is ReadingKind {
	return typeof v === "string" && (READING_KINDS as readonly string[]).includes(v);
}

export function isReadingMode(v: unknown): v is ReadingMode {
	return typeof v === "string" && (READING_MODES as readonly string[]).includes(v);
}

/** Running = the record still owes a terminal state. */
export function readingIsLive(r: Pick<ReadingRecord, "status">): boolean {
	return r.status === "queued" || r.status === "writing";
}
