/**
 * The capstone UI parse seam + seeded-start logic (capstone sessions,
 * 2026-11-01). Capstone tool INPUT is model-authored and can be partial or
 * malformed for a rejected call, so the cards read it only through these
 * parsers (the tool-parts rule: parse, don't cast): anything that does not
 * have the expected shape yields undefined / is dropped, never a crash.
 *
 * Also the gap report → "Teach these" / "Practice these" session bodies:
 * pure functions over the gaps and the graph's nodes, so the card is a thin
 * shell and the body construction is unit-tested.
 */

import type { CapstoneCriterion } from "./native-messages.ts";

export type VerdictStatus = "met" | "partial" | "unmet";

export interface CapstoneVerdictView {
	criterion: string;
	status: VerdictStatus;
	evidence: string;
}

export interface CapstoneGapView {
	area: string;
	note: string;
	targets: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function targetsOf(v: unknown): string[] {
	return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
}

export function parseBriefInput(input: unknown): { title: string; directory: string; criteria: CapstoneCriterion[] } | undefined {
	if (!isRecord(input) || !str(input.title) || !str(input.directory) || !Array.isArray(input.criteria)) return undefined;
	const criteria: CapstoneCriterion[] = [];
	for (const c of input.criteria) {
		if (!isRecord(c) || !str(c.id) || !str(c.text)) continue;
		criteria.push({ id: c.id, text: c.text, targets: targetsOf(c.targets) });
	}
	return { title: input.title, directory: input.directory, criteria };
}

function verdictsOf(v: unknown): CapstoneVerdictView[] {
	if (!Array.isArray(v)) return [];
	const out: CapstoneVerdictView[] = [];
	for (const item of v) {
		if (!isRecord(item) || !str(item.criterion) || !str(item.evidence)) continue;
		if (item.status !== "met" && item.status !== "partial" && item.status !== "unmet") continue;
		out.push({ criterion: item.criterion, status: item.status, evidence: item.evidence });
	}
	return out;
}

function gapsOf(v: unknown): CapstoneGapView[] {
	if (!Array.isArray(v)) return [];
	const out: CapstoneGapView[] = [];
	for (const g of v) {
		if (!isRecord(g) || !str(g.area) || !str(g.note)) continue;
		out.push({ area: g.area, note: g.note, targets: targetsOf(g.targets) });
	}
	return out;
}

export function parseReviewInput(input: unknown): { verdicts: CapstoneVerdictView[]; summary: string } | undefined {
	if (!isRecord(input) || !str(input.summary)) return undefined;
	return { verdicts: verdictsOf(input.verdicts), summary: input.summary };
}

export function parseEvaluateInput(
	input: unknown,
): { verdicts: CapstoneVerdictView[]; observations: string; gaps: CapstoneGapView[] } | undefined {
	if (!isRecord(input) || !str(input.observations)) return undefined;
	return { verdicts: verdictsOf(input.verdicts), observations: input.observations, gaps: gapsOf(input.gaps) };
}

export function parseGapReportInput(input: unknown): { summary: string; gaps: CapstoneGapView[] } | undefined {
	if (!isRecord(input) || !str(input.summary)) return undefined;
	return { summary: input.summary, gaps: gapsOf(input.gaps) };
}

// ─── seeded start ────────────────────────────────────────────────────────────

const REVISIT_AREAS = 4;

/** The auto-sent first message and title: the first four gap areas. */
export function revisitTitle(gaps: readonly Pick<CapstoneGapView, "area">[]): string {
	const areas = gaps.map((g) => g.area.trim()).filter((a) => a.length > 0);
	const shown = areas.slice(0, REVISIT_AREAS).join(", ");
	return `Revisit: ${shown}${areas.length > REVISIT_AREAS ? ", …" : ""}`;
}

export interface SeedNode {
	id: string;
	name: string;
	statement: string;
}

/** The creation body for a session seeded from a gap list: `teach` has no
 *  kind (absence reads as teach), `practice` carries it. graphContext is the
 *  gaps' tagged propositions that exist in the graph — none tagged (or none
 *  found) means a pickless, free-form start. */
export function seededSessionBody(
	as: "teach" | "practice",
	gaps: readonly CapstoneGapView[],
	nodes: readonly SeedNode[],
): { title: string; kind?: "practice"; graphContext?: { propositions: SeedNode[] } } {
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const seen = new Set<string>();
	const propositions: SeedNode[] = [];
	for (const gap of gaps) {
		for (const id of gap.targets) {
			const node = byId.get(id);
			if (node && !seen.has(id)) {
				seen.add(id);
				propositions.push({ id: node.id, name: node.name, statement: node.statement });
			}
		}
	}
	return {
		title: revisitTitle(gaps),
		...(as === "practice" ? { kind: "practice" as const } : {}),
		...(propositions.length > 0 ? { graphContext: { propositions } } : {}),
	};
}
