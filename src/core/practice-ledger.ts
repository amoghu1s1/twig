/**
 * Deterministic, pure fold over a Practice session's native messages.
 * Survives compaction completely (reads the entire record) so both the
 * Practice agent and the top progress strip always share one live truth.
 * Browser-safe (zero node:* imports).
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	DEFAULT_PRACTICE_META,
	type PracticeSessionMeta,
	type PracticeThinkingAction,
} from "./contracts/practice.ts";
import {
	cleanToolCallIds,
	isPracticePoseTool,
	PRACTICE_CONCLUDE_TOOL,
	type GraphContextPick,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";

export type TargetPracticeStatus = "untested" | "solid" | "shaky" | "missed";
export type PracticeDemandMode = "recall" | "discrimination" | "composition";

export interface TargetPracticeState {
	id: string;
	name: string;
	status: TargetPracticeStatus;
	modesTested: PracticeDemandMode[];
	attempts: number;
	highestRung: number | null;
	needsRetest: boolean;
}

export interface PracticeRetestItem {
	problemCallId: string;
	statement: string;
	targets: string[];
	targetNames: string[];
}

export interface ActivePracticeCounters {
	toolCallId: string;
	toolName: string;
	attempts: number;
	hints: number;
}

export interface PracticeLedger {
	problemsAttempted: number;
	problemsSolved: number;
	problemsWithHints: number;
	problemsRevealed: number;
	problemsVoided: number;
	targets: TargetPracticeState[];
	retestQueue: PracticeRetestItem[];
	activeProblem: ActivePracticeCounters | null;
}

function parseRungNumber(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	const match = /^R([0-5])$/.exec(raw);
	return match ? Number(match[1]) : null;
}

function normalizeMode(raw: unknown): PracticeDemandMode | null {
	return raw === "recall" || raw === "discrimination" || raw === "composition" ? raw : null;
}

function normalizeTargets(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((t): t is string => typeof t === "string" && t.length > 0))];
}

function isPluginPoseTool(
	m: LhMessage,
	contentIndex: number,
	block: { id: string; name: string },
	cleanIds: Set<string>,
): boolean {
	if (!cleanIds.has(block.id)) return false;
	if (isPracticePoseTool(block.name)) return true;
	// Also detect persisted plugin problem pose acks on toolResult details, or
	// fall back cleanly when caller only has native pose tools.
	return false;
}

export function foldPracticeLedger(messages: readonly LhMessage[]): PracticeLedger {
	const cleanIds = cleanToolCallIds(messages);

	// Detect plugin problem pose call ids by scanning toolResults carrying details.pluginProblem.
	const pluginPoseIds = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const details = (m as { details?: unknown; isError?: boolean; toolCallId?: string });
		if (details.isError) continue;
		if (
			details.details &&
			typeof details.details === "object" &&
			"pluginProblem" in (details.details as Record<string, unknown>) &&
			typeof details.toolCallId === "string"
		) {
			pluginPoseIds.add(details.toolCallId);
		}
	}

	const targetOrder: string[] = [];
	const targetMap = new Map<string, TargetPracticeState>();
	const ensureTarget = (id: string, name?: string): TargetPracticeState => {
		let entry = targetMap.get(id);
		if (!entry) {
			entry = {
				id,
				name: name?.trim() || id,
				status: "untested",
				modesTested: [],
				attempts: 0,
				highestRung: null,
				needsRetest: false,
			};
			targetMap.set(id, entry);
			targetOrder.push(id);
		} else if (name && entry.name === entry.id) {
			entry.name = name;
		}
		return entry;
	};

	let problemsAttempted = 0;
	let problemsSolved = 0;
	let problemsWithHints = 0;
	let problemsRevealed = 0;
	let problemsVoided = 0;
	let retestQueue: PracticeRetestItem[] = [];

	let activePose: {
		toolCallId: string;
		toolName: string;
		mode: PracticeDemandMode | null;
		targets: string[];
		statement: string;
		attempts: number;
		hints: number;
	} | null = null;

	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "custom") {
			const marker = m as LhMarkerMessage;
			if (marker.customType === "graph-context") {
				const details = marker.details as { propositions?: GraphContextPick[] } | undefined;
				for (const p of details?.propositions ?? []) {
					if (p && typeof p.id === "string") ensureTarget(p.id, p.name);
				}
				continue;
			}
			if (marker.customType === "problem-dismissed") {
				activePose = null;
				continue;
			}
			if (marker.customType === "practice-thinking" && activePose) {
				const details = marker.details as { problemCallId?: string; action?: PracticeThinkingAction } | undefined;
				if (details?.problemCallId && details.problemCallId !== activePose.toolCallId) continue;
				const action = details?.action ?? "submit";
				if (action === "hint") {
					activePose.hints += 1;
				} else if (action === "submit") {
					activePose.attempts += 1;
				}
				continue;
			}
			if (marker.customType === "practice-structured-submit" && activePose) {
				const details = marker.details as { problemCallId?: string } | undefined;
				if (!details?.problemCallId || details.problemCallId === activePose.toolCallId) {
					activePose.attempts += 1;
				}
				continue;
			}
			if (marker.customType === "plugin-problem-submission" && activePose) {
				activePose.attempts += 1;
				continue;
			}
			continue;
		}

		if (role !== "assistant") continue;
		const assistant = m as AssistantMessage;
		for (let bi = 0; bi < assistant.content.length; bi++) {
			const block = assistant.content[bi]!;
			if (block.type !== "toolCall") continue;
			if (isPluginPoseTool(m, bi, block, cleanIds) || (cleanIds.has(block.id) && pluginPoseIds.has(block.id))) {
				const args = (block.arguments ?? {}) as Record<string, unknown>;
				const targets = normalizeTargets(args.target);
				for (const tid of targets) ensureTarget(tid);
				activePose = {
					toolCallId: block.id,
					toolName: block.name,
					mode: normalizeMode(args.mode),
					targets,
					statement: typeof args.statement === "string" ? args.statement : "",
					attempts: 0,
					hints: 0,
				};
				continue;
			}
			if (block.name === PRACTICE_CONCLUDE_TOOL && cleanIds.has(block.id)) {
				const args = (block.arguments ?? {}) as Record<string, unknown>;
				const outcome = typeof args.outcome === "string" ? args.outcome : "";
				const rung = parseRungNumber(args.rung);
				const wantsRetest = args.retest === true;
				const pose = activePose;
				activePose = null;

				if (outcome === "voided") {
					problemsVoided += 1;
					continue;
				}
				if (outcome === "dismissed") {
					continue;
				}
				problemsAttempted += 1;
				if (outcome === "solved") problemsSolved += 1;
				else if (outcome === "solvedWithHints") problemsWithHints += 1;
				else if (outcome === "surrendered" || outcome === "movedOn") problemsRevealed += 1;

				if (!pose) continue;

				const clearedTargets = new Set<string>();
				for (const tid of pose.targets) {
					const t = ensureTarget(tid);
					t.attempts += 1;
					if (pose.mode && !t.modesTested.includes(pose.mode)) {
						t.modesTested.push(pose.mode);
					}
					if (rung !== null && (t.highestRung === null || rung > t.highestRung)) {
						t.highestRung = rung;
					}
					if (outcome === "solved" && (rung === null || rung <= 1)) {
						t.status = "solid";
						if (!wantsRetest) {
							t.needsRetest = false;
							clearedTargets.add(tid);
						}
					} else if (outcome === "solved" || outcome === "solvedWithHints") {
						if (t.status !== "missed") t.status = "shaky";
						else t.status = "shaky";
						if (!wantsRetest) {
							t.needsRetest = false;
							clearedTargets.add(tid);
						}
					} else if (outcome === "surrendered" || outcome === "movedOn") {
						t.status = "missed";
					}
					if (wantsRetest) {
						t.needsRetest = true;
					}
				}

				// Clear matching queued retests once a later non-voided problem succeeded on those targets.
				if (clearedTargets.size > 0) {
					retestQueue = retestQueue.filter((item) => {
						if (item.targets.length === 0) return true;
						const remaining = item.targets.filter((tid) => !clearedTargets.has(tid));
						return remaining.length > 0;
					});
				}
				// Also clear untagged retest if an untagged later problem was solved cleanly.
				if (pose.targets.length === 0 && (outcome === "solved" || outcome === "solvedWithHints") && !wantsRetest) {
					retestQueue = retestQueue.filter((item) => item.targets.length > 0);
				}

				if (wantsRetest) {
					retestQueue.push({
						problemCallId: pose.toolCallId,
						statement: pose.statement.replace(/\s+/g, " ").trim().slice(0, 120),
						targets: pose.targets,
						targetNames: pose.targets.map((tid) => targetMap.get(tid)?.name ?? tid),
					});
				}
			}
		}
	}

	return {
		problemsAttempted,
		problemsSolved,
		problemsWithHints,
		problemsRevealed,
		problemsVoided,
		targets: targetOrder.map((id) => targetMap.get(id)!),
		retestQueue,
		activeProblem: activePose
			? {
					toolCallId: activePose.toolCallId,
					toolName: activePose.toolName,
					attempts: activePose.attempts,
					hints: activePose.hints,
				}
			: null,
	};
}

function coachingGuidance(coaching: PracticeSessionMeta["coaching"], active: ActivePracticeCounters | null): string {
	switch (coaching) {
		case "socratic":
			return (
				"Coaching = SOCRATIC: Use strict one-rung hints (R0 → R5). Never auto-conclude on failure; stay with the learner until they solve it or explicitly click Show solution."
			);
		case "direct":
			return (
				"Coaching = DIRECT: Give crisp, immediate feedback. On a wrong submitted answer, localize exactly where their reasoning broke, reveal the solution by calling `conclude`, and explain clearly."
			);
		case "balanced": {
			const stuck = active !== null && (active.attempts >= 2 || active.hints >= 2);
			return (
				"Coaching = BALANCED: Start with concise, targeted nudges (escalating smoothly if the learner stays stuck). Never trap them in an endless grind" +
				(stuck
					? " — NOTE: the learner already has 2+ attempts/hints on this active problem; if they are still stuck now, explicitly offer to either reveal the solution (`Show solution`) or step down to an easier problem (`Easier`)."
					: " — after 2–3 stuck attempts or hints on one problem, explicitly offer to reveal the solution or step down to an easier problem.")
			);
		}
	}
}

function depthGuidance(depth: PracticeSessionMeta["depth"]): string {
	switch (depth) {
		case "recall":
			return "Depth = QUICK RECALL: Favor crisp 1–2 decision-point problems and quick structured checks (`practice_check` / `practice_match`) to exercise rapid retrieval and discrimination.";
		case "deep":
			return "Depth = DEEP MULTI-STEP: Favor rich multi-step composition problems, reverse/premise-probing twists, and substantive derivations or code challenges.";
		case "adaptive":
			return "Depth = ADAPTIVE: Follow the warm-up → interleaving → retest arc, stepping difficulty up on clean solves and down on misses.";
	}
}

function presentationGuidance(presentation: PracticeSessionMeta["presentation"]): string {
	switch (presentation) {
		case "theory":
			return "Style = THEORY: Frame problems in formal, abstract, or conceptual terms.";
		case "applied":
			return "Style = APPLIED: Frame problems as concrete scenarios, calculations, debugging, or real-world cases.";
		case "auto":
			return "Style = AUTO: Vary between theoretical and applied surfaces across problems to build transfer.";
	}
}

/** Format a compact, compaction-proof live ledger + dials block for the Practice agent. */
export function formatPracticeLedgerForPrompt(
	ledger: PracticeLedger,
	rawMeta?: Partial<PracticeSessionMeta> | null,
): string {
	const meta: PracticeSessionMeta = {
		coaching: rawMeta?.coaching ?? DEFAULT_PRACTICE_META.coaching,
		depth: rawMeta?.depth ?? DEFAULT_PRACTICE_META.depth,
		presentation: rawMeta?.presentation ?? DEFAULT_PRACTICE_META.presentation,
		verifySolutions: rawMeta?.verifySolutions ?? DEFAULT_PRACTICE_META.verifySolutions,
	};

	const lines: string[] = [
		"## Live session state & dials (authoritative — derived from the full record)",
		"",
		`- ${coachingGuidance(meta.coaching, ledger.activeProblem)}`,
		`- ${depthGuidance(meta.depth)}`,
		`- ${presentationGuidance(meta.presentation)}`,
		`- Progress: ${ledger.problemsAttempted} concluded (${ledger.problemsSolved} clean, ${ledger.problemsWithHints} with hints, ${ledger.problemsRevealed} revealed/moved on${ledger.problemsVoided > 0 ? `, ${ledger.problemsVoided} voided` : ""}).`,
	];

	if (ledger.activeProblem) {
		lines.push(
			`- Active problem (${ledger.activeProblem.toolName}): ${ledger.activeProblem.attempts} submission(s), ${ledger.activeProblem.hints} hint request(s) so far.`,
		);
	} else {
		lines.push("- Active problem: none (waiting in between-problems pause or session opening).");
	}

	if (ledger.targets.length > 0) {
		lines.push("", "Targets status:");
		for (const t of ledger.targets) {
			const modes = t.modesTested.length > 0 ? t.modesTested.join(", ") : "none yet";
			const rung = t.highestRung !== null ? ` · max hint R${t.highestRung}` : "";
			const retest = t.needsRetest ? " · NEEDS RETEST" : "";
			lines.push(`- [${t.id}] ${t.name}: ${t.status} (attempts: ${t.attempts}, modes: ${modes}${rung}${retest})`);
		}
	}

	if (ledger.retestQueue.length > 0) {
		lines.push("", "Pending retest queue (pose a fresh-surface problem covering these before wrapping up):");
		for (const item of ledger.retestQueue) {
			const who = item.targetNames.length > 0 ? item.targetNames.join(", ") : "untagged";
			lines.push(`- [${who}] ${item.statement || "(prior problem)"}`);
		}
	}

	return lines.join("\n");
}
