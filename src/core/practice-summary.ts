/**
 * Pure parser and seeded-session builder for Practice v2's Wrap-up Recap Card
 * (`practice_summary`) and remedial Teach / re-practice handoffs.
 * Browser-safe (zero node:* imports).
 */

import type { GraphNode } from "./contracts/graph.ts";
import type { PracticeSummaryData, PracticeSummaryItem } from "./contracts/practice.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function parseSummaryItems(raw: unknown): PracticeSummaryItem[] {
	if (!Array.isArray(raw)) return [];
	const items: PracticeSummaryItem[] = [];
	for (const entry of raw) {
		const rec = asRecord(entry);
		if (!rec || typeof rec.area !== "string" || typeof rec.note !== "string") continue;
		const area = rec.area.trim();
		const note = rec.note.trim();
		if (!area || !note) continue;
		const targets = Array.isArray(rec.targets)
			? [...new Set(rec.targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim()))]
			: [];
		items.push({ area, note, targets });
	}
	return items;
}

export function parsePracticeSummaryInput(raw: unknown): PracticeSummaryData | undefined {
	const rec = asRecord(raw);
	if (!rec || typeof rec.summary !== "string") return undefined;
	const summary = rec.summary.trim();
	if (!summary) return undefined;
	return {
		summary,
		solid: parseSummaryItems(rec.solid),
		needsPractice: parseSummaryItems(rec.needsPractice),
		remedialTeach: parseSummaryItems(rec.remedialTeach),
	};
}

export function buildPracticeRevisitTitle(
	items: readonly PracticeSummaryItem[],
	kind: "teach" | "practice",
): string {
	const areas = items.map((i) => i.area.trim()).filter(Boolean).slice(0, 3);
	if (areas.length === 0) {
		return kind === "teach" ? "Remedial lesson from practice" : "Targeted follow-up practice";
	}
	return kind === "teach" ? `Re-learn: ${areas.join(", ")}` : `Practice again: ${areas.join(", ")}`;
}

export interface PracticeSeededRequest {
	title: string;
	kind?: "practice";
	graphContext?: {
		propositions: Array<{ id: string; name: string; statement: string }>;
	};
	openingPrompt: string;
}

export function buildPracticeSeededRequest(
	items: readonly PracticeSummaryItem[],
	kind: "teach" | "practice",
	allNodes: readonly Pick<GraphNode, "id" | "name" | "statement">[],
): PracticeSeededRequest {
	const nodeMap = new Map(allNodes.map((n) => [n.id, n]));
	const pickedIds = new Set<string>();
	for (const item of items) {
		for (const t of item.targets) {
			if (nodeMap.has(t)) pickedIds.add(t);
		}
	}
	const propositions = [...pickedIds].map((id) => {
		const n = nodeMap.get(id)!;
		return { id: n.id, name: n.name, statement: n.statement };
	});

	const lines = items.map((item, idx) => `${idx + 1}. ${item.area}: ${item.note}`);
	const openingPrompt =
		kind === "teach"
			? [
					"Start a focused remedial teaching session based on what broke during my recent practice session:",
					"",
					...lines,
					"",
					"Probe briefly around these misconceptions first, then teach from the foundations so the concepts actually click.",
				].join("\n")
			: [
					"Run a targeted follow-up practice session on the concepts that were shaky in my previous session:",
					"",
					...lines,
					"",
					"Use fresh surfaces and start by warming up on these exact weak spots.",
				].join("\n");

	return {
		title: buildPracticeRevisitTitle(items, kind),
		...(kind === "practice" ? { kind: "practice" } : {}),
		...(propositions.length > 0 ? { graphContext: { propositions } } : {}),
		openingPrompt,
	};
}
