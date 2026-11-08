/**
 * The tidy-graph service (fork, 2026-11-07): run the tidier over the whole
 * graph, keep its proposals, and apply or skip the ones the learner picks
 * (core/graph-tidy.ts does the applying). One run at a time; applies are
 * synchronous blocks refused while an extraction runs (the deletion gate).
 */

import { randomBytes } from "node:crypto";
import { getGraph } from "../core/graph.ts";
import { applyTidyChange, type TidyProposal } from "../core/graph-tidy.ts";
import type { GraphStore } from "../core/ports.ts";
import { ModelsNotConfiguredError, ProviderKeyMissingError, ROLE_SLOT, type ModelSlotName, type ProviderKeyMissing } from "../core/settings.ts";
import type { PiEngine } from "../agent/models.ts";
import { runTidier } from "../agent/subagents/tidier.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import type { TidyState, TidyStore } from "../store/tidy.ts";

export interface TidyStatus extends TidyState {
	running: boolean;
	/** The last run's failure, until the next run starts. */
	error?: string;
}

export interface TidyResolveResult {
	applied: number;
	skipped: number;
	failed: Array<{ id: string; error: string }>;
	removedNodeIds: string[];
	createdNodeIds: string[];
}

export interface GraphTidyDeps {
	graphStore: GraphStore;
	store: TidyStore;
	topicTitle: (sourceId: string) => string;
	/** Test seam first, then the settings-resolved engine. */
	tidier?: PiEngine;
	engineFor?: (role: "tidier") => PiEngine | undefined;
	providerKeyMissing?: (provider: string, tier: ModelSlotName) => ProviderKeyMissing | null;
	/** True while an extraction may write the graph — applies wait. */
	extractionRunning?: () => boolean;
	/** After an apply changed the graph (Anki retire / card, events). */
	onApplied?: (result: TidyResolveResult) => void;
	now?: () => string;
}

export class TidyBusyError extends Error {}

export function createGraphTidy(deps: GraphTidyDeps) {
	const now = deps.now ?? (() => new Date().toISOString());
	let running: Promise<void> | null = null;
	let lastError: string | undefined;

	function engine(): PiEngine {
		const resolved = deps.tidier ?? deps.engineFor?.("tidier");
		if (!resolved) throw new ModelsNotConfiguredError([ROLE_SLOT.tidier]);
		const missing = deps.tidier ? null : deps.providerKeyMissing?.(resolved.model.provider, ROLE_SLOT.tidier);
		if (missing) throw new ProviderKeyMissingError(missing.provider, missing.slots);
		return resolved;
	}

	async function runOnce(tidierEngine: PiEngine): Promise<void> {
		const graph = getGraph(deps.graphStore);
		const found = await withBgLlmSlot(undefined, () =>
			runTidier({ engine: tidierEngine, nodes: graph.nodes, chains: graph.chains, topicTitle: deps.topicTitle }));
		const runAt = now();
		const history = deps.store.read().proposals.filter((p) => p.status !== "pending");
		const proposals: TidyProposal[] = found.map((p) => ({
			id: `tidy_${randomBytes(5).toString("hex")}`,
			change: p.change,
			reason: p.reason,
			status: "pending",
			createdAt: runAt,
		}));
		deps.store.write({ runAt, proposals: [...proposals, ...history].slice(0, 200) });
		console.info(`[tidy] ${proposals.length} proposal(s) over ${graph.nodes.length} proposition(s)`);
	}

	return {
		status(): TidyStatus {
			return { ...deps.store.read(), running: running !== null, ...(lastError ? { error: lastError } : {}) };
		},

		/** Start a run (engine refusals throw now, so the route can answer
		 *  them); resolves once the run is under way. */
		start(): { started: boolean } {
			if (running) return { started: false };
			const tidierEngine = engine();
			lastError = undefined;
			running = runOnce(tidierEngine)
				.catch((err: unknown) => {
					lastError = err instanceof Error ? err.message : String(err);
					console.error("[tidy] run failed:", err);
				})
				.finally(() => { running = null; });
			return { started: true };
		},

		/** Wait for the current run (tests). */
		async settled(): Promise<void> {
			await running;
		},

		/** Apply or skip pending proposals, in the order given. Applies run
		 *  back to back with no awaits: one atomic stretch of the event loop. */
		resolve(ids: ReadonlyArray<string>, action: "apply" | "skip"): TidyResolveResult {
			if (action === "apply" && deps.extractionRunning?.()) throw new TidyBusyError("An extraction is running — try again when it finishes");
			const state = deps.store.read();
			const byId = new Map(state.proposals.map((p) => [p.id, p]));
			const result: TidyResolveResult = { applied: 0, skipped: 0, failed: [], removedNodeIds: [], createdNodeIds: [] };
			for (const id of ids) {
				const proposal = byId.get(id);
				if (!proposal || proposal.status !== "pending") continue;
				proposal.resolvedAt = now();
				if (action === "skip") {
					proposal.status = "skipped";
					result.skipped++;
					continue;
				}
				try {
					const applied = applyTidyChange(deps.graphStore, proposal.change, proposal.resolvedAt);
					proposal.status = "applied";
					result.applied++;
					result.removedNodeIds.push(...applied.removedNodeIds);
					result.createdNodeIds.push(...applied.createdNodeIds);
				} catch (err) {
					proposal.status = "skipped";
					proposal.error = err instanceof Error ? err.message : String(err);
					result.failed.push({ id, error: proposal.error });
				}
			}
			deps.store.write(state);
			if (result.applied > 0) deps.onApplied?.(result);
			return result;
		},
	};
}

export type GraphTidy = ReturnType<typeof createGraphTidy>;
