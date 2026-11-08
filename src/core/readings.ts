/**
 * Readings — the pure core (docs/readings.md). Browser-safe: no IO, no
 * node builtins. Owns:
 *
 * - request validation (the route's 400s),
 * - snapshot building (what the writer sees, frozen at creation),
 * - the citation law (every cited URL was successfully fetched in the run),
 * - the node → readings fold (the graph detail card's "Readings" list —
 *   derived at read time, never written into the graph).
 */

import type { LhMessage } from "./native-messages.ts";
import type { PlanTree } from "./contracts/plan.ts";
import { derivePlanStatusesLh, derivedNodeStatus, type PlanNodeStatus } from "./contracts/plan.ts";
import { sessionMarkdown } from "./session-markdown.ts";
import type {
	ReadingKind,
	ReadingProposition,
	ReadingRecord,
	ReadingRequest,
	ReadingSnapshot,
	ReadingSummary,
	ReadingSource,
} from "./contracts/readings.ts";
import { isReadingKind, isReadingMode, READING_KIND_LABEL } from "./contracts/readings.ts";

// ─── limits ─────────────────────────────────────────────────────────────────

/** Transcript budgets (characters). Recaps need the whole session; deep
 *  dives and primers need enough to see what was taught and how. */
export const TRANSCRIPT_BUDGET: Readonly<Record<ReadingKind, number>> = {
	recap: 160_000,
	"deep-dive": 60_000,
	primer: 30_000,
	overview: 30_000,
	node: 0,
};
export const MAX_REQUEST_CHARS = 2_000;
export const MAX_PASSAGE_CHARS = 4_000;
export const MAX_TOPIC_CHARS = 500;
export const MAX_NODE_PICKS = 64;

// ─── request validation ─────────────────────────────────────────────────────

/** Normalize + validate a POST body. Returns the cleaned request or the
 *  first problem (the route turns it into a 400). Kind-specific anchor
 *  rules: primer and overview need a session or a topic; deep-dive needs a session
 *  and a plan node or a passage; recap needs a session; node needs picks. */
export function parseReadingRequest(body: unknown): { ok: true; value: ReadingRequest } | { ok: false; error: string } {
	if (typeof body !== "object" || body === null) return { ok: false, error: "Body must be a JSON object" };
	const b = body as Record<string, unknown>;
	const str = (v: unknown, max: number): string | undefined => {
		if (typeof v !== "string") return undefined;
		const t = v.trim();
		return t ? t.slice(0, max) : undefined;
	};
	// A re-run copies the original's kind + anchor + request server-side;
	// the kind here is a placeholder the server replaces.
	if (typeof b.rerunOf === "string" && b.rerunOf) {
		if (b.mode !== undefined && !isReadingMode(b.mode)) return { ok: false, error: "mode must be researched or model" };
		return { ok: true, value: { kind: "recap", rerunOf: b.rerunOf, ...(isReadingMode(b.mode) ? { mode: b.mode } : {}) } };
	}
	if (!isReadingKind(b.kind)) return { ok: false, error: "kind must be one of primer, overview, deep-dive, recap, node" };
	if (b.mode !== undefined && !isReadingMode(b.mode)) return { ok: false, error: "mode must be researched or model" };
	const value: ReadingRequest = { kind: b.kind };
	if (isReadingMode(b.mode)) value.mode = b.mode;
	const request = str(b.request, MAX_REQUEST_CHARS);
	if (request) value.request = request;
	const chatId = str(b.chatId, 200);
	if (chatId) value.chatId = chatId;
	const planNodeId = str(b.planNodeId, 200);
	if (planNodeId) value.planNodeId = planNodeId;
	const messageId = str(b.messageId, 200);
	if (messageId) value.messageId = messageId;
	const passage = str(b.passage, MAX_PASSAGE_CHARS);
	if (passage) value.passage = passage;
	const topic = str(b.topic, MAX_TOPIC_CHARS);
	if (topic) value.topic = topic;
	const suggestionCallId = str(b.suggestionCallId, 200);
	if (suggestionCallId) value.suggestionCallId = suggestionCallId;
	if (Array.isArray(b.nodeIds)) {
		const ids = [...new Set(b.nodeIds.filter((x): x is string => typeof x === "string" && x.length > 0))].slice(0, MAX_NODE_PICKS);
		if (ids.length > 0) value.nodeIds = ids;
	}
	switch (value.kind) {
		case "primer":
			if (!value.chatId && !value.topic) return { ok: false, error: "A primer needs a session (chatId) or a topic" };
			break;
		case "overview":
			if (!value.chatId && !value.topic) return { ok: false, error: "An overview needs a session (chatId) or a topic" };
			break;
		case "deep-dive":
			if (!value.chatId) return { ok: false, error: "A deep dive needs a session (chatId)" };
			if (!value.planNodeId && !value.passage) return { ok: false, error: "A deep dive needs a plan node or a passage" };
			break;
		case "recap":
			if (!value.chatId) return { ok: false, error: "A recap needs a session (chatId)" };
			break;
		case "node":
			if (!value.nodeIds) return { ok: false, error: "A node reading needs at least one proposition (nodeIds)" };
			break;
	}
	return { ok: true, value };
}

// ─── snapshot building ──────────────────────────────────────────────────────

/** The probe's assessment as plain text (the latest probe_done call), or
 *  undefined before the probe concludes. */
export function assessmentText(messages: readonly LhMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown };
		if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
		for (const block of m.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || block.name !== "probe_done") continue;
			const a = (block.arguments as { assessment?: { strands?: unknown; summary?: unknown } } | undefined)?.assessment;
			if (!a || typeof a !== "object") continue;
			const lines: string[] = [];
			if (typeof a.summary === "string" && a.summary.trim()) lines.push(`Summary: ${a.summary.trim()}`);
			if (Array.isArray(a.strands)) {
				for (const s of a.strands as Array<{ strand?: unknown; assessment?: unknown }>) {
					if (typeof s?.strand === "string") {
						lines.push(`- ${s.strand}: ${typeof s.assessment === "string" ? s.assessment : ""}`.trimEnd());
					}
				}
			}
			if (lines.length > 0) return lines.join("\n");
		}
	}
	return undefined;
}

/** The plan with derived statuses, one line per node + the edges. */
export function planText(tree: PlanTree | undefined, messages: readonly LhMessage[]): string | undefined {
	if (!tree || tree.nodes.length === 0) return undefined;
	const statuses = derivePlanStatusesLh(tree, messages);
	const title = new Map(tree.nodes.map((n) => [n.id, n.title] as const));
	const lines = tree.nodes.map((n) => {
		const summary = n.summary ? ` — ${n.summary}` : "";
		return `- [${derivedNodeStatus(statuses, n.id)}] ${n.title} (${n.id})${summary}`;
	});
	if (tree.edges.length > 0) {
		lines.push("Requires (prerequisite → dependent):");
		for (const e of tree.edges) lines.push(`- ${title.get(e.from) ?? e.from} → ${title.get(e.to) ?? e.to}`);
	}
	return lines.join("\n");
}

/** Trim a transcript to a character budget: keep the opening (the goal
 *  and the probe) and the most recent stretch, with an honest elision
 *  marker between them. */
export function budgetTranscript(markdown: string, budget: number): { text: string; trimmed: boolean } {
	if (budget <= 0) return { text: "", trimmed: markdown.length > 0 };
	if (markdown.length <= budget) return { text: markdown, trimmed: false };
	const head = Math.floor(budget * 0.2);
	const tail = budget - head;
	return {
		text: `${markdown.slice(0, head)}\n\n[… ${markdown.length - budget} characters of the middle of the session omitted …]\n\n${markdown.slice(markdown.length - tail)}`,
		trimmed: true,
	};
}

/** The session-side inputs a snapshot needs (structural — the chat
 *  record satisfies it). */
export interface SnapshotChat {
	title: string;
	messages: readonly LhMessage[];
	tree?: PlanTree;
}

/** Build a session-anchored snapshot (primer, overview, deep-dive, recap). Returns
 *  an error string when the anchor doesn't resolve (unknown plan node). */
export function buildSessionSnapshot(
	kind: Exclude<ReadingKind, "node">,
	chat: SnapshotChat,
	anchor: { planNodeId?: string; messageId?: string; passage?: string },
	propositions?: ReadingProposition[],
): { ok: true; snapshot: ReadingSnapshot } | { ok: false; error: string } {
	const snapshot: ReadingSnapshot = { sessionTitle: chat.title };
	const assessment = assessmentText(chat.messages);
	if (assessment) snapshot.assessment = assessment;
	const plan = planText(chat.tree, chat.messages);
	if (plan) snapshot.plan = plan;

	if (kind === "deep-dive" && anchor.planNodeId) {
		const node = chat.tree?.nodes.find((n) => n.id === anchor.planNodeId);
		if (!node) return { ok: false, error: `Unknown plan node: ${anchor.planNodeId}` };
		snapshot.focus = { title: node.title, ...(node.summary ? { summary: node.summary } : {}) };
		const statuses = derivePlanStatusesLh(chat.tree!, chat.messages);
		snapshot.upcoming = chat
			.tree!.nodes.filter((n) => n.id !== node.id && derivedNodeStatus(statuses, n.id) === "upcoming")
			.map((n) => n.title);
	} else if (kind === "deep-dive" && chat.tree) {
		// A passage deep dive still respects the lesson's order.
		const statuses = derivePlanStatusesLh(chat.tree, chat.messages);
		snapshot.upcoming = chat.tree.nodes.filter((n) => derivedNodeStatus(statuses, n.id) === "upcoming").map((n) => n.title);
	} else if (kind === "overview" && chat.tree && chat.tree.nodes.length > 0) {
		// The map may name every part; the fence keeps upcoming ones underived.
		const statuses = derivePlanStatusesLh(chat.tree, chat.messages);
		snapshot.planNodes = chat.tree.nodes.map((n) => ({ id: n.id, title: n.title }));
		snapshot.upcoming = chat.tree.nodes.filter((n) => derivedNodeStatus(statuses, n.id) === "upcoming").map((n) => n.title);
	}

	const budget = TRANSCRIPT_BUDGET[kind];
	if (budget > 0) {
		const md = sessionMarkdown(chat.messages, { anchors: false });
		if (md.trim()) {
			const { text, trimmed } = budgetTranscript(md, budget);
			snapshot.transcript = text;
			if (trimmed) snapshot.transcriptTrimmed = true;
		}
	}
	if (kind === "recap" && propositions && propositions.length > 0) snapshot.propositions = propositions;
	if (kind === "recap" && !snapshot.transcript) return { ok: false, error: "This session has nothing to recap yet" };
	return { ok: true, snapshot };
}

/** Build a graph-anchored snapshot (node readings). */
export function buildNodeSnapshot(propositions: ReadingProposition[], chains: string[]): ReadingSnapshot {
	return { propositions, ...(chains.length > 0 ? { chains } : {}) };
}

/** A sensible title before the writer names it. */
export function provisionalTitle(
	kind: ReadingKind,
	ctx: { focus?: string; passage?: string; sessionTitle?: string; topic?: string; propositions?: ReadingProposition[] },
): string {
	const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
	switch (kind) {
		case "primer":
			return `Key terms: ${clip(ctx.topic ?? ctx.sessionTitle ?? "this lesson")}`;
		case "overview":
			return `Overview: ${clip(ctx.topic ?? ctx.sessionTitle ?? "this lesson")}`;
		case "recap":
			return `Recap: ${clip(ctx.sessionTitle ?? "session")}`;
		case "deep-dive":
			return ctx.focus ? `Deep dive: ${clip(ctx.focus)}` : `Deep dive: “${clip(ctx.passage ?? "passage", 48)}”`;
		case "node": {
			const names = (ctx.propositions ?? []).map((p) => p.name);
			return `Deep dive: ${clip(names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : ""))}`;
		}
	}
}

// ─── the citation law ───────────────────────────────────────────────────────

/** Canonical form for comparing cited URLs against fetched ones: no
 *  fragment, no trailing slash, lowercase scheme + host. */
export function normalizeUrl(raw: string): string {
	try {
		const u = new URL(raw.trim());
		u.hash = "";
		const s = `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${u.pathname}${u.search}`;
		return s.endsWith("/") ? s.slice(0, -1) : s;
	} catch {
		return raw.trim();
	}
}

/** Did a fetch tool's output carry real content? (The web tools never
 *  throw: failures come back as "<tool> failed…" strings, and web_fetch
 *  answers a PDF with a pointer to web_fetch_pdf.) */
export function fetchSucceeded(toolName: string, output: string): boolean {
	const t = output.trimStart();
	if (t.startsWith(`${toolName} failed`)) return false;
	if (toolName === "web_fetch" && t.startsWith("web_fetch: this URL is a PDF")) return false;
	return t.length > 0;
}

/** Every http(s) URL written in free text (markdown links and bare
 *  autolinks), trailing punctuation trimmed. */
export function urlsInText(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)) {
		out.add(m[0].replace(/[.,;:!?]+$/, ""));
	}
	return [...out];
}

/** Every cited URL must be one the run fetched successfully. Returns one
 *  problem string per offending URL (empty = clean). Model mode forbids
 *  sources entirely. */
export function citationProblems(
	cited: ReadonlyArray<Pick<ReadingSource, "url">>,
	fetched: ReadonlySet<string>,
	mode: "researched" | "model",
): string[] {
	if (mode === "model") {
		return cited.length > 0
			? ["This reading is written from model knowledge only: sources and further reading must be empty (no web access was used)."]
			: [];
	}
	const problems: string[] = [];
	for (const { url } of cited) {
		if (!fetched.has(normalizeUrl(url))) {
			problems.push(
				`Cited URL was never successfully fetched in this run: ${url}. Fetch it with web_fetch (or web_fetch_pdf) first, or remove it — only cite pages you actually read.`,
			);
		}
	}
	return problems;
}

// ─── reading views ──────────────────────────────────────────────────────────

/** The list row: the record minus its heavy fields. */
export function summarizeReading(r: ReadingRecord): ReadingSummary {
	const { snapshot: _s, body: _b, terms: _t, sections: _sec, furtherReading: _f, sources: _src, ...rest } = r;
	return rest;
}

/** The graph detail card's fold: readings ABOUT this node (node readings
 *  that picked it) plus session readings from any session the node came
 *  up in (its provenance). Newest first, superseded versions hidden. */
/** Originals replaced by a re-run that is ready or still being written —
 *  a failed or stopped re-run never hides the good original. */
function supersededIds(readings: ReadonlyArray<Pick<ReadingRecord, "supersedes"> & { status?: ReadingRecord["status"] }>): Set<string> {
	return new Set(
		readings
			.filter((r) => r.supersedes && r.status !== "error")
			.map((r) => r.supersedes as string),
	);
}

export function readingsForNode<R extends Pick<ReadingRecord, "id" | "anchor" | "createdAt" | "supersedes"> & { status?: ReadingRecord["status"] }>(
	readings: readonly R[],
	node: { id: string; provenance: ReadonlyArray<{ chatId: string }> },
): R[] {
	const sessions = new Set(node.provenance.map((p) => p.chatId));
	const superseded = supersededIds(readings);
	return readings
		.filter((r) => !superseded.has(r.id))
		.filter((r) => r.anchor.nodeIds?.includes(node.id) || (r.anchor.chatId !== undefined && sessions.has(r.anchor.chatId)))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Each plan node's status in the session as it stands NOW (an
 *  overview's node chips — read live, so they follow the lesson).
 *  Nodes no longer in the plan are left out. */
export function planNodeStatuses(chat: SnapshotChat, nodeIds: readonly string[]): Record<string, PlanNodeStatus> {
	if (!chat.tree || nodeIds.length === 0) return {};
	const statuses = derivePlanStatusesLh(chat.tree, chat.messages);
	const present = new Set(chat.tree.nodes.map((n) => n.id));
	const out: Record<string, PlanNodeStatus> = {};
	for (const id of nodeIds) if (present.has(id)) out[id] = derivedNodeStatus(statuses, id);
	return out;
}

/** A session's readings, newest first, superseded versions hidden. */
export function readingsForChat<R extends Pick<ReadingRecord, "id" | "anchor" | "createdAt" | "supersedes"> & { status?: ReadingRecord["status"] }>(
	readings: readonly R[],
	chatId: string,
): R[] {
	const superseded = supersededIds(readings);
	return readings
		.filter((r) => r.anchor.chatId === chatId && !superseded.has(r.id))
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** A reading as one portable markdown document (the export). */
export function readingMarkdown(
	r: Pick<ReadingRecord, "title" | "kind" | "mode" | "body" | "terms" | "sections" | "sources" | "furtherReading" | "createdAt"> & {
		snapshot?: Pick<ReadingSnapshot, "planNodes">;
	},
): string {
	const out: string[] = [`# ${r.title}`];
	out.push(
		`*${READING_KIND_LABEL[r.kind]} · ${r.mode === "researched" ? "researched" : "written from model knowledge — not source-checked"} · ${r.createdAt.slice(0, 10)}*`,
	);
	if (r.body?.trim()) out.push(r.body.trim());
	if (r.sections && r.sections.length > 0) {
		const titles = new Map((r.snapshot?.planNodes ?? []).map((n) => [n.id, n.title] as const));
		for (const sec of r.sections) {
			const nodes = (sec.planNodeIds ?? []).map((id) => titles.get(id) ?? id);
			out.push(`## ${sec.heading}`);
			if (nodes.length > 0) out.push(`*In your lesson: ${nodes.join(", ")}*`);
			if (sec.body.trim()) out.push(sec.body.trim());
		}
	}
	if (r.terms && r.terms.length > 0) {
		out.push("## Terms", r.terms.map((t) => `**${t.term}** — ${t.definition}`).join("\n\n"));
	}
	if (r.sources && r.sources.length > 0) {
		out.push("## Sources", r.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n"));
	}
	if (r.furtherReading && r.furtherReading.length > 0) {
		out.push(
			"## Further reading",
			r.furtherReading.map((f) => `- [${f.title}](${f.url})${f.level ? ` *(${f.level})*` : ""} — ${f.why}`).join("\n"),
		);
	}
	return out.join("\n\n") + "\n";
}
