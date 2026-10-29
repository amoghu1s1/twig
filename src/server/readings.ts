/**
 * Readings — the server composition (docs/readings.md §5/§9). The routes'
 * one seam: request → snapshot (frozen) → record (queued) → the writer
 * pipeline, plus list/get/delete/abort and the dock's rows. Composition
 * only: snapshots are pure core (core/readings.ts), the writer lives in
 * the agent layer, persistence in the store adapter.
 */

import { createReadingsPipeline, readingRunStatuses, type RunningReading } from "../agent/subagents/readings.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { providerKeyMissing as providerKeyMissingEnvelope } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import {
	buildNodeSnapshot,
	buildSessionSnapshot,
	planNodeStatuses,
	provisionalTitle,
	readingsForChat,
	readingsForNode,
	summarizeReading,
} from "../core/readings.ts";
import { chainsForSelection, formatChainLine } from "../core/chains.ts";
import { getGraph, graphSessionPropositions } from "../core/graph.ts";
import {
	DEFAULT_READING_MODE,
	type PlanNodeStatus,
	type ReadingProposition,
	type ReadingRecord,
	type ReadingRequest,
	type ReadingSnapshot,
	type ReadingSummary,
} from "../core/contracts.ts";
import { stores } from "./stores.ts";
import { providerKeyPresent } from "./keys.ts";
import { searchProvider } from "./search.ts";
import { jobCost } from "./pricing.ts";
import { deleteDiscussionOf } from "./reading-discussions.ts";

export type { RunningReading };

/** The app's ONE readings pipeline (module instance; the run registry
 *  itself is globalThis-backed, so every Next route entry shares it). */
export const readingsPipeline = createReadingsPipeline({
	readingStore: stores.readingStore,
	// BYOK: role override → slot → nothing, read FRESH per run.
	engineFor: (role) => {
		const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
		return spec ? piEngineForSpec(spec) : undefined;
	},
	providerKeyMissing: (provider, tier) => (providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier])),
	searchProvider,
});

/** The orphan sweep runs lazily on reads (cheap: one small JSON per
 *  reading), at most every 30 s per process. */
function sweepOnce(): void {
	const g = globalThis as typeof globalThis & { __lhReadingsSweptAt?: number };
	if (g.__lhReadingsSweptAt && Date.now() - g.__lhReadingsSweptAt < 30_000) return;
	g.__lhReadingsSweptAt = Date.now();
	readingsPipeline.sweep();
}

export class ReadingRequestError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 404 | 503,
	) {
		super(message);
		this.name = "ReadingRequestError";
	}
}

/** Propositions as the writer sees them, from live graph nodes. */
function propositionsFor(ids: readonly string[]): ReadingProposition[] {
	const byId = new Map(getGraph(stores.graphStore).nodes.map((n) => [n.id, n] as const));
	return ids
		.map((id) => byId.get(id))
		.filter((n) => n !== undefined)
		.map((n) => ({ id: n.id, name: n.name, statement: n.statement }));
}

/** The propositions first articulated in a session (graph birth). */
function bornIn(chatId: string): ReadingProposition[] {
	const born = graphSessionPropositions({ chatStore: stores.chatStore, graphStore: stores.graphStore }, chatId);
	return propositionsFor(born.map((b) => b.nodeId));
}

function newReadingId(): string {
	return `rd_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Create a reading and start writing it. Throws ReadingRequestError for
 * the route's 4xx/503. Returns the new record.
 */
export function createReading(req: ReadingRequest): ReadingRecord {
	sweepOnce();
	// Re-run: copy the original's kind + anchor + request; the snapshot
	// is rebuilt fresh (a recap re-run covers what happened since).
	let base = req;
	let supersedes: string | undefined;
	if (req.rerunOf) {
		const original = stores.readingStore.getReading(req.rerunOf);
		if (!original) throw new ReadingRequestError("Unknown reading", 404);
		const a = original.anchor;
		base = {
			kind: original.kind,
			mode: req.mode ?? original.mode,
			...(original.request ? { request: original.request } : {}),
			...(a.chatId ? { chatId: a.chatId } : {}),
			...(a.planNodeId ? { planNodeId: a.planNodeId } : {}),
			...(a.messageId ? { messageId: a.messageId } : {}),
			...(a.passage ? { passage: a.passage } : {}),
			...(a.nodeIds ? { nodeIds: a.nodeIds } : {}),
			...(a.topic ? { topic: a.topic } : {}),
			...(a.suggestionCallId ? { suggestionCallId: a.suggestionCallId } : {}),
		};
		supersedes = original.id;
	}

	const refused = readingsPipeline.refusal();
	if (refused) throw new ReadingRequestError(refused, 503);

	let snapshot: ReadingSnapshot;
	let planVersion: number | undefined;
	let title: string;
	if (base.kind === "node") {
		const props = propositionsFor(base.nodeIds ?? []);
		if (props.length === 0) throw new ReadingRequestError("None of the picked propositions exist in the graph", 400);
		const graph = getGraph(stores.graphStore);
		const byId = Object.fromEntries(graph.nodes.map((n) => [n.id, n] as const));
		const chains = chainsForSelection(props, graph.chains)
			.filter((c) => c.premises.length > 0)
			.map((c) => formatChainLine(c, byId));
		snapshot = buildNodeSnapshot(props, chains);
		title = provisionalTitle("node", { propositions: props });
	} else if (base.chatId) {
		const chat = stores.chatStore.getChat(base.chatId);
		if (!chat) throw new ReadingRequestError("Unknown session", 404);
		if (chat.kind === "practice") throw new ReadingRequestError("Readings attach to teaching sessions", 400);
		const built = buildSessionSnapshot(
			base.kind,
			chat,
			{ planNodeId: base.planNodeId, messageId: base.messageId, passage: base.passage },
			base.kind === "recap" ? bornIn(chat.id) : undefined,
		);
		if (!built.ok) throw new ReadingRequestError(built.error, 400);
		snapshot = built.snapshot;
		planVersion = chat.tree?.version;
		title = provisionalTitle(base.kind, {
			focus: snapshot.focus?.title,
			passage: base.passage,
			sessionTitle: chat.title,
		});
	} else {
		// A primer or overview from a bare topic (before any session).
		snapshot = {};
		title = provisionalTitle(base.kind, { topic: base.topic });
	}

	const now = new Date().toISOString();
	const record: ReadingRecord = {
		id: newReadingId(),
		kind: base.kind,
		mode: base.mode ?? DEFAULT_READING_MODE,
		status: "queued",
		title,
		...(base.request ? { request: base.request } : {}),
		anchor: {
			...(base.chatId ? { chatId: base.chatId } : {}),
			...(base.planNodeId ? { planNodeId: base.planNodeId } : {}),
			...(planVersion !== undefined && base.planNodeId ? { planVersion } : {}),
			...(base.messageId ? { messageId: base.messageId } : {}),
			...(base.passage ? { passage: base.passage } : {}),
			...(base.kind === "node" && snapshot.propositions ? { nodeIds: snapshot.propositions.map((p) => p.id) } : {}),
			...(base.topic && !base.chatId ? { topic: base.topic } : {}),
			...(base.suggestionCallId ? { suggestionCallId: base.suggestionCallId } : {}),
		},
		snapshot,
		...(supersedes ? { supersedes } : {}),
		createdAt: now,
		updatedAt: now,
	};
	stores.readingStore.createReading(record);
	readingsPipeline.start(record.id);
	return record;
}

function withCost(r: ReadingRecord, titles?: Map<string, string>): ReadingSummary {
	const chatTitle = r.anchor.chatId ? titles?.get(r.anchor.chatId) : undefined;
	return { ...summarizeReading(r), costUsd: r.usage ? jobCost({ usage: r.usage }) : null, ...(chatTitle ? { chatTitle } : {}) };
}

/** The list view, optionally scoped. Superseded versions are hidden in
 *  the scoped views (the library shows everything). */
export function listReadings(filter: { chatId?: string; nodeId?: string } = {}): ReadingSummary[] {
	sweepOnce();
	const all = stores.readingStore.listReadings();
	if (filter.chatId) return readingsForChat(all, filter.chatId).map((r) => withCost(r));
	if (filter.nodeId) {
		const node = getGraph(stores.graphStore).nodes.find((n) => n.id === filter.nodeId);
		return node ? readingsForNode(all, node).map((r) => withCost(r)) : [];
	}
	const titles = new Map(stores.chatStore.listChats().map((c) => [c.id, c.title] as const));
	return all.map((r) => withCost(r, titles));
}

/** One reading in full, plus the live practice hand-off set and, for an
 *  overview, its tagged plan nodes' statuses in the session right now. */
export function getReading(
	id: string,
): (ReadingRecord & { costUsd: number | null; practice: ReadingProposition[]; chatTitle?: string; planStatus?: Record<string, PlanNodeStatus> }) | null {
	const found = stores.readingStore.getReading(id);
	if (!found) return null;
	const r = readingsPipeline.settleIfOrphaned(found);
	// Practice this: the reading's own propositions (node readings, recaps)
	// or, for session readings, what the session has produced since.
	// Read LIVE (deleted nodes drop out; a session keeps producing).
	const practice = r.anchor.nodeIds
		? propositionsFor(r.anchor.nodeIds)
		: r.anchor.chatId
			? bornIn(r.anchor.chatId)
			: [];
	const chat = r.anchor.chatId ? stores.chatStore.getChat(r.anchor.chatId) : undefined;
	const chatTitle = chat?.title;
	const tagged = (r.sections ?? []).flatMap((sec) => sec.planNodeIds ?? []);
	const planStatus = chat && tagged.length > 0 ? planNodeStatuses(chat, tagged) : undefined;
	return {
		...r,
		costUsd: r.usage ? jobCost({ usage: r.usage }) : null,
		practice,
		...(chatTitle ? { chatTitle } : {}),
		...(planStatus ? { planStatus } : {}),
	};
}

/** Delete: a live run is stopped first; the reading's discussion goes
 *  with it (owner ruling, docs/readings.md §14). */
export function deleteReading(id: string): boolean {
	readingsPipeline.abort(id);
	const deleted = stores.readingStore.deleteReading(id);
	if (deleted) deleteDiscussionOf(id);
	return deleted;
}

/** The dock's END control. */
export function abortReading(id: string): { ok: true } | { ok: false; reason: "not_running" } {
	return readingsPipeline.abort(id) ? { ok: true } : { ok: false, reason: "not_running" };
}

/** The activity dock's rows (cost joined). */
export function readingActivity(): Array<RunningReading & { costUsd: number | null }> {
	return readingRunStatuses().map((row) => {
		const r = stores.readingStore.getReading(row.id);
		return { ...row, title: r?.title ?? row.title, costUsd: r?.usage ? jobCost({ usage: r.usage }) : null };
	});
}


