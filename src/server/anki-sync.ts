/**
 * ANKI SYNC — the graph → Anki channel (core/anki.ts holds the shapes).
 *
 * One operation, idempotent over the whole graph: card every in-scope
 * proposition that has no record yet (the card writer, cheap slot), then
 * deliver every undelivered record to Anki through AnkiConnect. Because
 * records persist before delivery, an unreachable Anki (closed, add-on
 * missing) loses nothing: the cards wait in data/anki/cards.json and the
 * next sync sends them. A node already in Anki (its `lh::<id>` tag found)
 * is marked delivered without adding — so a lost cards.json never
 * duplicates.
 *
 * The graph and sessions are only READ here. Single-flight: a sync that
 * arrives while one runs waits for it, then runs (its scope may differ).
 */

import type { GraphStore, AnkiStore } from "../core/ports.ts";
import { getGraph } from "../core/graph.ts";
import {
	DEFAULT_ANKICONNECT_URL,
	ankiModelDefinitions,
	birthSource,
	deckName,
	nodeTag,
	nodesNeedingCards,
	pendingRecords,
	renderAnkiTsv,
	toAnkiConnectNotes,
	type AnkiNoteRecord,
} from "../core/anki.ts";
import type { GraphNode } from "../core/contracts.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, ROLE_SLOT, type ModelSlotName, type ProviderKeyMissing } from "../core/settings.ts";
import type { PiEngine } from "../agent/models.ts";
import { CARD_WRITER_BATCH, writeCards } from "../agent/subagents/card-writer.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";

// ─── AnkiConnect (https://git.foosoft.net/alex/anki-connect, API v6) ────────

export class AnkiConnectError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AnkiConnectError";
	}
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface AnkiConnect {
	invoke<T>(action: string, params?: Record<string, unknown>): Promise<T>;
}

export function createAnkiConnect(url: string, fetchFn: FetchLike = fetch as unknown as FetchLike, timeoutMs = 10_000): AnkiConnect {
	return {
		async invoke<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
			let response;
			try {
				response = await fetchFn(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action, version: 6, params }),
					signal: AbortSignal.timeout(timeoutMs),
				});
			} catch (err) {
				throw new AnkiConnectError(`Anki is not reachable at ${url} (is Anki open with AnkiConnect installed?): ${err instanceof Error ? err.message : String(err)}`);
			}
			if (!response.ok) throw new AnkiConnectError(`AnkiConnect answered HTTP ${response.status}`);
			const body = (await response.json()) as { result?: T; error?: string | null };
			if (body.error) throw new AnkiConnectError(`AnkiConnect ${action}: ${body.error}`);
			return body.result as T;
		},
	};
}

// ─── the service ────────────────────────────────────────────────────────────

export interface AnkiSyncScope {
	/** Only these propositions (ids). */
	nodeIds?: ReadonlyArray<string>;
	/** Only propositions born in these sources (chat ids / src_ ids). */
	sourceIds?: ReadonlyArray<string>;
}

export interface AnkiSyncResult {
	/** Propositions newly carded this run. */
	carded: number;
	/** Cards (Anki notes) added to Anki this run. */
	added: number;
	/** Propositions Anki already held (tag found) — nothing added. */
	alreadyInAnki: number;
	/** Propositions carded but not yet in Anki (Anki unreachable). */
	waiting: number;
	ankiReachable: boolean;
	/** Why Anki could not be reached, when it could not. */
	ankiError?: string;
}

export interface AnkiStatus {
	ankiReachable: boolean;
	ankiError?: string;
	/** Propositions with cards (delivered or waiting). */
	carded: number;
	waiting: number;
	/** Propositions in the graph with no cards yet. */
	uncarded: number;
}

export interface AnkiSyncDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	ankiStore: AnkiStore;
	/** A source's display title (chat title, renamed source, notes file). */
	sourceTitle: (sourceId: string) => string | undefined;
	/** Test seam first, then the settings-resolved engine. */
	cardWriter?: PiEngine;
	engineFor?: (role: "cardWriter") => PiEngine | undefined;
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
	anki?: AnkiConnect;
	ankiUrl?: string;
	now?: () => string;
}

export interface AnkiSync {
	sync(scope?: AnkiSyncScope): Promise<AnkiSyncResult>;
	/** Delete the scope's cards from Anki and from the store, then card it
	 *  afresh (a better card writer, or cards the learner disliked). Needs
	 *  Anki reachable: deleting only the store would duplicate in Anki. */
	rebuild(scope?: AnkiSyncScope): Promise<AnkiSyncResult & { removed: number }>;
	status(): Promise<AnkiStatus>;
	/** Every carded proposition as a File > Import text file. */
	importFile(): string;
}

export function createAnkiSync(deps: AnkiSyncDeps): AnkiSync {
	const anki = deps.anki ?? createAnkiConnect(deps.ankiUrl ?? process.env.LH_ANKICONNECT_URL ?? DEFAULT_ANKICONNECT_URL);
	const now = deps.now ?? (() => new Date().toISOString());
	let tail: Promise<unknown> = Promise.resolve();

	function inScope(nodes: GraphNode[], scope: AnkiSyncScope | undefined): GraphNode[] {
		if (scope?.nodeIds) {
			const ids = new Set(scope.nodeIds);
			nodes = nodes.filter((n) => ids.has(n.id));
		}
		if (scope?.sourceIds) {
			const sources = new Set(scope.sourceIds);
			nodes = nodes.filter((n) => sources.has(birthSource(n) ?? ""));
		}
		// Practice sessions write nothing to the graph; a node with no
		// provenance has no source to deck it under — skip it.
		return nodes.filter((n) => birthSource(n) !== undefined);
	}

	function cardWriterEngine(): PiEngine {
		const engine = deps.cardWriter ?? deps.engineFor?.("cardWriter");
		if (!engine) throw new ModelsNotConfiguredError([ROLE_SLOT.cardWriter]);
		const missing = deps.cardWriter ? null : deps.providerKeyMissing?.(engine.model.provider, ROLE_SLOT.cardWriter);
		if (missing) throw new ProviderKeyMissingError(missing.provider, missing.slots);
		return engine;
	}

	/** Card what needs carding; each batch persists as it lands, so a
	 *  failure part-way keeps every earlier batch's cards. */
	async function card(nodes: GraphNode[], byId: Map<string, GraphNode>, chains: ReturnType<typeof getGraph>["chains"]): Promise<number> {
		if (nodes.length === 0) return 0;
		const engine = cardWriterEngine();
		let carded = 0;
		for (let i = 0; i < nodes.length; i += CARD_WRITER_BATCH) {
			const batch = nodes.slice(i, i + CARD_WRITER_BATCH);
			const cards = await withBgLlmSlot(undefined, () => writeCards({ engine, nodes: batch, chains, byId }));
			const records: AnkiNoteRecord[] = batch.flatMap((node) => {
				const nodeCards = cards.get(node.id);
				const sourceId = birthSource(node);
				if (!nodeCards || nodeCards.length === 0 || !sourceId) return [];
				return [{ nodeId: node.id, sourceId, deck: deckName(deps.sourceTitle(sourceId)), cards: nodeCards, createdAt: now() }];
			});
			deps.ankiStore.upsertRecords(records);
			carded += records.length;
		}
		return carded;
	}

	async function deliver(byId: Map<string, GraphNode>): Promise<Pick<AnkiSyncResult, "added" | "alreadyInAnki" | "waiting" | "ankiReachable" | "ankiError">> {
		const pending = pendingRecords(deps.ankiStore.readRecords()).filter((r) => byId.has(r.nodeId));
		try {
			await anki.invoke<number>("version");
		} catch (err) {
			return { added: 0, alreadyInAnki: 0, waiting: pending.length, ankiReachable: false, ankiError: err instanceof Error ? err.message : String(err) };
		}
		if (pending.length > 0) await ensureModels();
		let added = 0;
		let alreadyInAnki = 0;
		for (const deck of new Set(pending.map((r) => r.deck))) await anki.invoke("createDeck", { deck });
		for (const record of pending) {
			const existing = await anki.invoke<number[]>("findNotes", { query: `"tag:${nodeTag(record.nodeId)}"` });
			let noteIds = existing;
			if (existing.length > 0) {
				alreadyInAnki++;
			} else {
				const notes = toAnkiConnectNotes(record, byId.get(record.nodeId)?.name ?? "");
				const ids = await anki.invoke<Array<number | null>>("addNotes", { notes });
				noteIds = ids.filter((id): id is number => typeof id === "number");
				added += noteIds.length;
			}
			deps.ankiStore.upsertRecords([{ ...record, deliveredAt: now(), noteIds }]);
		}
		return { added, alreadyInAnki, waiting: 0, ankiReachable: true };
	}

	/** Create the LearnHarness note types when missing; restyle the ones
	 *  that exist so template and CSS improvements reach old cards too. */
	async function ensureModels(): Promise<void> {
		const existing = new Set(await anki.invoke<string[]>("modelNames"));
		for (const model of ankiModelDefinitions()) {
			if (!existing.has(model.modelName)) {
				await anki.invoke("createModel", { ...model });
				continue;
			}
			await anki.invoke("updateModelStyling", { model: { name: model.modelName, css: model.css } });
			await anki.invoke("updateModelTemplates", {
				model: { name: model.modelName, templates: Object.fromEntries(model.cardTemplates.map((t) => [t.Name, { Front: t.Front, Back: t.Back }])) },
			});
		}
	}

	async function runRebuild(scope: AnkiSyncScope | undefined): Promise<AnkiSyncResult & { removed: number }> {
		const graph = getGraph(deps.graphStore);
		const inScopeIds = new Set(inScope(graph.nodes, scope).map((n) => n.id));
		const records = [...deps.ankiStore.readRecords().values()].filter((r) => inScopeIds.has(r.nodeId));
		await anki.invoke<number>("version"); // throws AnkiConnectError: never forget cards Anki still holds
		const noteIds = new Set<number>();
		for (const record of records) {
			for (const id of record.noteIds ?? []) noteIds.add(id);
			for (const id of await anki.invoke<number[]>("findNotes", { query: `"tag:${nodeTag(record.nodeId)}"` })) noteIds.add(id);
		}
		if (noteIds.size > 0) await anki.invoke("deleteNotes", { notes: [...noteIds] });
		deps.ankiStore.deleteRecords(records.map((r) => r.nodeId));
		console.info(`[anki] rebuild: removed ${noteIds.size} note(s) for ${records.length} proposition(s)`);
		return { removed: noteIds.size, ...(await runSync(scope)) };
	}

	async function runSync(scope: AnkiSyncScope | undefined): Promise<AnkiSyncResult> {
		const graph = getGraph(deps.graphStore);
		const byId = new Map(graph.nodes.map((n) => [n.id, n]));
		const need = nodesNeedingCards(inScope(graph.nodes, scope), deps.ankiStore.readRecords());
		const carded = await card(need, byId, graph.chains);
		const delivery = await deliver(byId);
		console.info(`[anki] carded ${carded}, added ${delivery.added} card(s), ${delivery.alreadyInAnki} already in Anki, ${delivery.waiting} waiting`);
		return { carded, ...delivery };
	}

	return {
		sync(scope) {
			const run = tail.catch(() => {}).then(() => runSync(scope));
			tail = run;
			return run;
		},
		rebuild(scope) {
			const run = tail.catch(() => {}).then(() => runRebuild(scope));
			tail = run;
			return run;
		},
		async status() {
			const graph = getGraph(deps.graphStore);
			const records = deps.ankiStore.readRecords();
			const live = [...records.values()].filter((r) => graph.nodes.some((n) => n.id === r.nodeId));
			const base = {
				carded: live.length,
				waiting: live.filter((r) => !r.deliveredAt).length,
				uncarded: nodesNeedingCards(inScope(graph.nodes, undefined), records).length,
			};
			try {
				await anki.invoke<number>("version");
				return { ankiReachable: true, ...base };
			} catch (err) {
				return { ankiReachable: false, ankiError: err instanceof Error ? err.message : String(err), ...base };
			}
		},
		importFile() {
			const graph = getGraph(deps.graphStore);
			const names = new Map(graph.nodes.map((n) => [n.id, n.name]));
			const records = [...deps.ankiStore.readRecords().values()].filter((r) => names.has(r.nodeId));
			return renderAnkiTsv(records, names);
		},
	};
}

/** A sync failure as an HTTP answer: the BYOK refusals keep their 503
 *  envelopes (the client already renders them); anything else is a 500. */
export function ankiSyncErrorResponse(err: unknown): Response {
	if (err instanceof ModelsNotConfiguredError || err instanceof ProviderKeyMissingError) {
		return Response.json(err.envelope, { status: 503 });
	}
	if (err instanceof AnkiConnectError) return Response.json({ error: err.message }, { status: 502 });
	console.error("[anki] sync failed:", err);
	return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
}
