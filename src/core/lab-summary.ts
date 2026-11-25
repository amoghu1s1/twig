/**
 * Pure parser and seeded-session builder for Twig Lab's Knowledge Graph summary bridge.
 * Browser-safe (zero node:* imports).
 */

import type { GraphNode } from "./contracts/graph.ts";

export interface LabGapItem {
	area: string;
	note: string;
	targets: string[];
}

export interface LabSummaryData {
	summary: string;
	milestonesCompleted: string[];
	gaps: LabGapItem[];
}

export interface LabSeededRequest {
	title: string;
	kind?: "practice";
	graphContext?: {
		propositions: Array<{ id: string; name: string; statement: string }>;
	};
	openingPrompt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function parseLabSummaryInput(raw: unknown): LabSummaryData | undefined {
	const rec = asRecord(raw);
	if (!rec || typeof rec.summary !== "string") return undefined;
	const summary = rec.summary.trim();
	if (!summary) return undefined;

	const milestonesCompleted = Array.isArray(rec.milestonesCompleted)
		? rec.milestonesCompleted
				.filter((m): m is string => typeof m === "string" && m.trim().length > 0)
				.map((m) => m.trim())
		: [];

	const gaps: LabGapItem[] = [];
	if (Array.isArray(rec.gaps)) {
		for (const entry of rec.gaps) {
			const g = asRecord(entry);
			if (!g || typeof g.area !== "string" || typeof g.note !== "string") continue;
			const area = g.area.trim();
			const note = g.note.trim();
			if (!area || !note) continue;
			const targets = Array.isArray(g.targets)
				? g.targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim())
				: [];
			gaps.push({ area, note, targets });
		}
	}

	return {
		summary,
		milestonesCompleted,
		gaps,
	};
}

export function buildLabRevisitTitle(gaps: readonly LabGapItem[]): string {
	const areas = gaps.map((g) => g.area.trim()).filter(Boolean).slice(0, 3);
	if (areas.length === 0) return "Revisit Lab concepts";
	return `Revisit: ${areas.join(", ")}`;
}

export function buildLabSeededRequest(
	gaps: readonly LabGapItem[],
	kind: "teach" | "practice",
	allNodes: readonly Pick<GraphNode, "id" | "name" | "statement">[],
): LabSeededRequest {
	const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
	const seenIds = new Set<string>();
	const propositions: Array<{ id: string; name: string; statement: string }> = [];

	for (const gap of gaps) {
		for (const id of gap.targets) {
			if (seenIds.has(id)) continue;
			const node = nodeMap.get(id);
			if (node) {
				seenIds.add(id);
				propositions.push({ id: node.id, name: node.name, statement: node.statement });
			}
		}
	}

	const title = buildLabRevisitTitle(gaps);
	const gapLines = gaps.map((g) => `- ${g.area}: ${g.note}`).join("\n");
	const openingPrompt =
		gaps.length > 0
			? `From my recent Lab session, help me ${kind === "practice" ? "practice" : "revisit and solidify"} these gaps:\n${gapLines}`
			: title;

	return {
		title,
		...(kind === "practice" ? { kind: "practice" } : {}),
		...(propositions.length > 0 ? { graphContext: { propositions } } : {}),
		openingPrompt,
	};
}
