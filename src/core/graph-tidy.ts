/**
 * Tidy graph (fork, 2026-11-07) — the graph's third writer, after the
 * merger and deletion. A model pass over the WHOLE graph proposes three
 * kinds of change; the learner accepts or skips each one; this module
 * checks and applies an accepted one, deterministically, with no model.
 *
 *   merge    two nodes state the SAME idea in different words (the
 *            auditor missed it at merge time). The dropped node's lines
 *            are re-keyed onto the kept node — appended AFTER the kept
 *            node's first line, so the kept identity stands and the
 *            dropped statement becomes an alias — and every chain
 *            through it is rewired. Simplification then folds repeats.
 *   split    one node bundles separate facts ("abolition AND
 *            compensation"). Each part becomes its own node and a chain
 *            parts ⟹ original records that the bundle follows from them —
 *            nothing is deleted, and the atoms can now be linked by later
 *            lessons.
 *   connect  a chain whose premises come from different topics, ending in
 *            an existing node or in a NEW bridge idea. Its provenance is
 *            the Connections pseudo-source, so it reads as the tidy pass's
 *            claim, never as something a lesson said.
 *
 * Every apply runs as ONE synchronous block (no awaits — atomic vs the
 * event loop, the deletion precedent), and re-checks its proposal against
 * the graph AS IT IS NOW: a proposal whose nodes have since gone is
 * refused, not half-applied.
 */

import type { GraphChain, GraphNode, ProvenancePoint } from "./contracts.ts";
import type { GraphStore } from "./ports.ts";
import { chainKey, getGraph, newGraphChainId, newGraphNodeId, simplifyChains } from "./graph.ts";

import { TIDY_SOURCE_ID } from "./tidy-source.ts";

export { TIDY_SOURCE_ID, TIDY_SOURCE_LABEL } from "./tidy-source.ts";

export interface TidyIdea {
	name: string;
	statement: string;
}

export type TidyChange =
	| { kind: "merge"; keep: string; drop: string }
	| { kind: "split"; node: string; parts: TidyIdea[] }
	| { kind: "connect"; premises: string[]; conclusion?: string; newIdea?: TidyIdea };

export type TidyStatus = "pending" | "applied" | "skipped";

export interface TidyProposal {
	id: string;
	change: TidyChange;
	/** One line, for the learner: why this change is right. */
	reason: string;
	status: TidyStatus;
	createdAt: string;
	/** Set when applied or refused at apply time. */
	resolvedAt?: string;
	/** Why an accepted proposal could not be applied (graph moved on). */
	error?: string;
}

export interface TidyApplyResult {
	/** Nodes the change removed (merge drops) — their Anki cards retire. */
	removedNodeIds: string[];
	/** Nodes the change created (split parts, bridge ideas). */
	createdNodeIds: string[];
	chainsAdded: number;
}

const birth = (node: GraphNode | undefined): string | undefined => node?.provenance[0]?.chatId;

/** The proposal's law against the CURRENT graph: null when applicable. */
export function tidyProblem(change: TidyChange, nodes: ReadonlyMap<string, GraphNode>, chains: ReadonlyArray<GraphChain>): string | null {
	const missing = (id: string) => (nodes.has(id) ? null : `node ${id} no longer exists`);
	switch (change.kind) {
		case "merge":
			if (change.keep === change.drop) return "a node cannot merge with itself";
			return missing(change.keep) ?? missing(change.drop);
		case "split": {
			const gone = missing(change.node);
			if (gone) return gone;
			if (change.parts.length < 2) return "a split needs at least two parts";
			if (change.parts.some((p) => p.name.trim() === "" || p.statement.trim() === "")) return "every part needs a name and a statement";
			return null;
		}
		case "connect": {
			if (change.premises.length === 0) return "a connection needs premises";
			for (const id of change.premises) {
				const gone = missing(id);
				if (gone) return gone;
			}
			if ((change.conclusion === undefined) === (change.newIdea === undefined)) return "a connection ends in exactly one existing node or one new idea";
			if (change.conclusion !== undefined) {
				const gone = missing(change.conclusion);
				if (gone) return gone;
				if (change.premises.includes(change.conclusion)) return "a conclusion cannot be its own premise";
				const key = chainKey([...new Set(change.premises)], change.conclusion);
				if (chains.some((c) => chainKey(c.premises, c.conclusion) === key)) return "the graph already holds this chain";
			} else if (change.newIdea!.name.trim() === "" || change.newIdea!.statement.trim() === "") {
				return "the new idea needs a name and a statement";
			}
			const topics = new Set([...change.premises, ...(change.conclusion ? [change.conclusion] : [])].map((id) => birth(nodes.get(id)) ?? id));
			if (topics.size < 2) return "a connection must bring together ideas from different topics";
			return null;
		}
	}
}

/** Chat-level points, one per source (chains and new nodes need no
 *  message anchor). */
function sourcePoints(points: ReadonlyArray<ProvenancePoint>): ProvenancePoint[] {
	return [...new Set(points.map((p) => p.chatId))].map((chatId) => ({ chatId, messageId: "" }));
}

/** Apply ONE change. Throws with the reason when it no longer fits. */
export function applyTidyChange(graphStore: GraphStore, change: TidyChange, now = new Date().toISOString()): TidyApplyResult {
	const graph = getGraph(graphStore);
	const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
	const problem = tidyProblem(change, nodes, graph.chains);
	if (problem) throw new Error(problem);

	switch (change.kind) {
		case "merge": {
			const lines = graphStore.readNodes();
			const kept = lines.filter((l) => l.id !== change.drop);
			const moved = lines.filter((l) => l.id === change.drop).map((l) => ({ ...l, id: change.keep }));
			const rewire = (id: string) => (id === change.drop ? change.keep : id);
			const chainLines = graphStore.readChains().flatMap((line): GraphChain[] => {
				const conclusion = rewire(line.conclusion);
				const premises = [...new Set(line.premises.map(rewire))].filter((p) => p !== conclusion);
				return premises.length === 0 ? [] : [{ ...line, premises, conclusion }];
			});
			graphStore.rewriteLedgers({ nodes: [...kept, ...moved], chains: simplifyChains(chainLines) });
			const positions = graphStore.readPositions();
			if (positions[change.drop] !== undefined) {
				const { [change.drop]: _gone, ...rest } = positions;
				graphStore.writePositions(rest);
			}
			return { removedNodeIds: [change.drop], createdNodeIds: [], chainsAdded: 0 };
		}
		case "split": {
			const original = nodes.get(change.node)!;
			const provenance = sourcePoints(original.provenance);
			const parts = change.parts.map((part): GraphNode => ({
				id: newGraphNodeId(),
				name: part.name.trim(),
				statement: part.statement.trim(),
				aliases: [],
				createdAt: now,
				provenance,
			}));
			for (const part of parts) graphStore.appendNode(part);
			graphStore.appendChain({ id: newGraphChainId(), premises: parts.map((p) => p.id), conclusion: change.node, createdAt: now, provenance });
			return { removedNodeIds: [], createdNodeIds: parts.map((p) => p.id), chainsAdded: 1 };
		}
		case "connect": {
			const provenance: ProvenancePoint[] = [{ chatId: TIDY_SOURCE_ID, messageId: "" }];
			let conclusion = change.conclusion;
			const created: string[] = [];
			if (conclusion === undefined) {
				const idea: GraphNode = {
					id: newGraphNodeId(),
					name: change.newIdea!.name.trim(),
					statement: change.newIdea!.statement.trim(),
					aliases: [],
					createdAt: now,
					provenance,
				};
				graphStore.appendNode(idea);
				conclusion = idea.id;
				created.push(idea.id);
			}
			graphStore.appendChain({ id: newGraphChainId(), premises: [...new Set(change.premises)], conclusion, createdAt: now, provenance });
			return { removedNodeIds: [], createdNodeIds: created, chainsAdded: 1 };
		}
	}
}
