import type { GraphNode } from "./contracts/graph.ts";
import { stripModelValueDebris } from "./value-debris.ts";

/**
 * Selection-facing chain views — pure + browser-safe (the shell's chain
 * table consumes these; the barrel exports them). Born in the practice
 * contracts (2026-09-29), orphaned onto their own module when the batch
 * practice module was replaced by practice sessions (2026-10-04).
 */

/** One reasoning chain — a selection-facing VIEW of stored follows-edges:
 *  all edges into one conclusion, as premises → that conclusion. Singleton
 *  chains (premises: []) carry edge-less nodes. */
export interface ReasoningChain {
	/** The chain's identity — the CONCLUSION node's id (chains group by
	 *  conclusion, so the two are one). */
	id: string;
	/** Premise node ids — every follows-edge source into the conclusion,
	 *  sorted. Empty = a singleton chain (an edge-less node). */
	premises: string[];
	/** The conclusion node id (=== id; mirrored so renderings read
	 *  "premises → conclusion" without indirection). */
	conclusion: string;
}

/** The stored chains filtered to a selection (chains-primary, owner
 *  2026-09-30): a chain rides along iff its conclusion AND every premise
 *  are selected; a node in no surviving chain is a singleton chain
 *  (premises: []). Premise-only nodes whose chain was excluded are
 *  singletons — the same inclusion law as the pre-chains edge grouping.
 *  Every stored chain keeps its OWN id (arg_…) — two independent
 *  arguments for one conclusion stay distinct. Deterministic: chains
 *  sorted by id, premises sorted. */
export function chainsForSelection(
	nodes: ReadonlyArray<Pick<{ id: string }, "id">>,
	chains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
): ReasoningChain[] {
	const selected = new Set(nodes.map((n) => n.id));
	const chained = new Set<string>();
	const included: ReasoningChain[] = [];
	for (const chain of chains) {
		if (!selected.has(chain.conclusion)) continue;
		if (!chain.premises.every((premise) => selected.has(premise))) continue;
		included.push({ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion });
		chained.add(chain.conclusion);
		for (const premise of chain.premises) chained.add(premise);
	}
	for (const node of nodes) {
		if (!chained.has(node.id)) {
			included.push({ id: node.id, premises: [], conclusion: node.id });
		}
	}
	return included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A chain as one world-facing line — the propositions' NAMES joined
 *  by the derivation arrow: "Premise one, Premise two → Conclusion"; a
 *  singleton shows its "(no premises)" marker. Pure + browser-safe.
 *  Unknown ids fall back to the raw id (honest, never guessed).
 *  Premises sort by id — the same determinism law as chainsForSelection. */
/** Resolve ONE target string to a canonical proposition id (owner round
 *  9, 2026-10-05 — the mastery-trace contract): id first (exact), then
 *  name (case-insensitive, trimmed — names are presentational handles,
 *  not unique; an ambiguous name resolves to the FIRST node in store
 *  order). Returns null when nothing matches — the caller rejects.
 *  Validation set is the WHOLE graph, not the session's picks: pickless
 *  sessions and future graph-tools poses stay valid. The debris strip
 *  (whitehead, 2026-10-09) heals copy-syntax (`:node-id`, quoted ids)
 *  before matching — targets are membership values like correctAnswer. */
export function resolveTargetId(
	target: string,
	nodes: ReadonlyArray<Pick<GraphNode, "id" | "name">>,
): string | null {
	const t = stripModelValueDebris(target);
	if (t.length === 0) return null;
	if (nodes.some((n) => n.id === t)) return t;
	const lower = t.toLowerCase();
	for (const n of nodes) {
		if (stripModelValueDebris(n.name).toLowerCase() === lower) return n.id;
	}
	return null;
}

export function formatChainLine(
	chain: Pick<ReasoningChain, "premises" | "conclusion">,
	propositions: Readonly<Record<string, { name: string }>>,
): string {
	const nameOf = (id: string) => propositions[id]?.name ?? id;
	const premises = [...chain.premises].sort().map(nameOf).join(", ");
	return premises !== ""
		? `${premises} → ${nameOf(chain.conclusion)}`
		: `${nameOf(chain.conclusion)} (no premises)`;
}

export interface NeighborContextPick {
	id: string;
	name: string;
	statement: string;
}

/**
 * Strict 1-hop reasoning-chain neighbors for a picked proposition set:
 * finds stored chains touching at least one picked node AND at least one
 * unpicked node, ranks those outside nodes by how many connecting chains they
 * share with the selection (then id ascending), caps at `maxNeighbors`, and
 * returns the selected neighbor nodes plus the formatted connecting chains
 * whose endpoints all lie inside `picked ∪ selectedNeighbors`.
 */
export function neighborContextForSelection(
	pickedNodes: ReadonlyArray<Pick<GraphNode, "id">>,
	allNodes: ReadonlyArray<Pick<GraphNode, "id" | "name" | "statement">>,
	allChains: ReadonlyArray<Pick<{ id: string; premises: string[]; conclusion: string }, "id" | "premises" | "conclusion">>,
	maxNeighbors = 12,
): { neighbors: NeighborContextPick[]; neighborChains: string[] } {
	if (pickedNodes.length === 0 || maxNeighbors <= 0) {
		return { neighbors: [], neighborChains: [] };
	}
	const pickedIds = new Set(pickedNodes.map((n) => n.id));
	const byId = new Map(allNodes.map((n) => [n.id, n]));
	const touchCounts = new Map<string, number>();
	const candidateChains: Array<{ id: string; premises: string[]; conclusion: string; outsideIds: string[] }> = [];

	for (const chain of allChains) {
		const endpoints = [...new Set([...chain.premises, chain.conclusion])];
		const touchesPicked = endpoints.some((id) => pickedIds.has(id));
		if (!touchesPicked) continue;
		const outsideIds = endpoints.filter((id) => !pickedIds.has(id) && byId.has(id));
		if (outsideIds.length === 0) continue;
		candidateChains.push({
			id: chain.id,
			premises: [...chain.premises].sort(),
			conclusion: chain.conclusion,
			outsideIds,
		});
		for (const id of outsideIds) {
			touchCounts.set(id, (touchCounts.get(id) ?? 0) + 1);
		}
	}

	if (touchCounts.size === 0) {
		return { neighbors: [], neighborChains: [] };
	}

	const rankedNeighborIds = [...touchCounts.entries()]
		.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.slice(0, maxNeighbors)
		.map(([id]) => id);
	const neighborSet = new Set(rankedNeighborIds);

	const neighbors: NeighborContextPick[] = rankedNeighborIds.map((id) => {
		const n = byId.get(id)!;
		return { id: n.id, name: n.name, statement: n.statement };
	});

	const nodeNameMap = Object.fromEntries(allNodes.map((n) => [n.id, { name: n.name }]));
	const neighborChains = candidateChains
		.filter((c) => c.outsideIds.every((id) => neighborSet.has(id)))
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
		.map((c) => formatChainLine(c, nodeNameMap));

	return { neighbors, neighborChains };
}
