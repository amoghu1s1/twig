/**
 * Pure coaching-level helpers for Twig Lab v2. Browser-safe (zero node:* imports).
 */

import type { LabCell, LabNudgeLevel } from "./contracts/lab.ts";
import type { LhMessage } from "./native-messages.ts";

export const DEFAULT_LAB_NUDGE_LEVEL: LabNudgeLevel = "nudge";

export type LabCoachingStage = "pointer_only" | "escalate_ok" | "direct";

export function normalizeLabNudgeLevel(value: unknown): LabNudgeLevel {
	if (value === "nudge" || value === "balanced" || value === "direct") {
		return value;
	}
	return DEFAULT_LAB_NUDGE_LEVEL;
}

export function isCellFailing(cell: LabCell): boolean {
	if (cell.role === "check" && cell.checkResult?.passed === false) return true;
	return cell.outputs.some((out) => out.outputType === "error");
}

function messageText(msg: LhMessage): string {
	if (!("content" in msg)) return "";
	if (typeof msg.content === "string") return msg.content;
	if (!Array.isArray(msg.content)) return "";
	return msg.content
		.filter((p): p is { type: "text"; text: string } => typeof p === "object" && p !== null && p.type === "text" && typeof p.text === "string")
		.map((p) => p.text)
		.join("\n");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Inspect `read_notebook` results for `cellId` to extract its snippet status.
 * Returns "failing" | "passing" | null (not mentioned in this tool result).
 */
function inspectCellStatusInReadResult(text: string, cellId: string): "failing" | "passing" | null {
	const headerRe = new RegExp(`^--- Cell \\d+ .*\\bid=${escapeRegExp(cellId)}\\b.*$`, "m");
	const match = headerRe.exec(text);
	if (!match) return null;
	const start = match.index + match[0].length;
	const rest = text.slice(start);
	const nextHeader = rest.search(/^--- Cell \d+ /m);
	const section = nextHeader === -1 ? rest : rest.slice(0, nextHeader);
	if (/Check status: FAILED|Check result: FAILED|\nerror:\n/m.test(section)) {
		return "failing";
	}
	return "passing";
}

/**
 * Count how many prior assistant responses already addressed the active failure on `cellId`.
 * Walks backward through persisted transcript turns and stops cleanly if it hits a
 * `read_notebook` snapshot where `cellId` was passing.
 */
export function countPriorMentorNudges(messages: readonly LhMessage[], cellId: string): number {
	if (!cellId) return 0;

	// Group messages cleanly into chronological turn segments separated by user messages.
	type Turn = {
		userText: string;
		assistantText: string;
		cellStatusInRead: "failing" | "passing" | null;
	};
	const turns: Turn[] = [];
	let current: Turn | null = null;

	for (const msg of messages) {
		if (msg.role === "user") {
			if (current) turns.push(current);
			current = {
				userText: messageText(msg),
				assistantText: "",
				cellStatusInRead: null,
			};
			continue;
		}
		if (!current) {
			current = { userText: "", assistantText: "", cellStatusInRead: null };
		}
		if (msg.role === "assistant") {
			const txt = messageText(msg).trim();
			if (txt) {
				current.assistantText = current.assistantText ? `${current.assistantText}\n${txt}` : txt;
			}
		} else if (msg.role === "toolResult" && msg.toolName === "read_notebook") {
			const status = inspectCellStatusInReadResult(messageText(msg), cellId);
			if (status) current.cellStatusInRead = status;
		}
	}
	if (current) turns.push(current);

	let count = 0;
	for (let i = turns.length - 1; i >= 0; i--) {
		const turn = turns[i]!;
		if (turn.cellStatusInRead === "passing") break;
		if (!turn.assistantText) continue;
		const userMentionedCell = turn.userText.includes(cellId);
		if (turn.cellStatusInRead === "failing" || userMentionedCell) {
			count++;
		}
	}
	return count;
}

/**
 * Compute whether the mentor must restrict its reply to a diagnostic pointer
 * (`pointer_only`) or is allowed to supply a concrete repair (`escalate_ok` / `direct`).
 */
export function computeCellCoachingStage(opts: {
	nudgeLevel: LabNudgeLevel;
	failedRunCount: number;
	priorMentorNudges: number;
}): LabCoachingStage {
	if (opts.nudgeLevel === "direct") return "direct";
	if (opts.nudgeLevel === "nudge" && opts.priorMentorNudges === 0 && opts.failedRunCount <= 1) {
		return "pointer_only";
	}
	return "escalate_ok";
}

export function formatNudgeGuidanceBanner(nudgeLevel: LabNudgeLevel): string {
	switch (nudgeLevel) {
		case "nudge":
			return [
				"Active session coaching mode: NUDGE FIRST (strict).",
				"- When a failing cell is tagged `coaching=pointer_only`, give ONLY a grounded diagnostic pointer (cell number, line, exact failing assumption, and one concrete next step). Do NOT write drop-in solution or replacement implementation code for the failing block.",
				"- Unlock concrete repair code only when the cell is tagged `coaching=escalate_ok` (after a prior nudge or second failing attempt) OR when the learner explicitly asks for the full fix/example.",
				"- Direct Python/library syntax or API questions are still answered immediately and concisely.",
			].join("\n");
		case "balanced":
			return [
				"Active session coaching mode: BALANCED.",
				"- Start failing-cell help with the exact diagnostic cause and at most a minimal 1–2 line API sketch; provide a full repair if the learner tries again or asks.",
				"- Direct syntax and API questions are answered immediately.",
			].join("\n");
		case "direct":
			return [
				"Active session coaching mode: DIRECT (pair programming).",
				"- Diagnose bugs with exact runtime evidence and provide clear, working repair code right away while still explaining why it works and never overwriting learner-edited cells silently.",
			].join("\n");
	}
}
