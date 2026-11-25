import type { PlanTree } from "./contracts/plan.ts";
import { isPositionToolPart } from "./pending.ts";
import { textPartMessageId } from "./session-navigation.ts";
import { posedPluginQuestionOfPart } from "./tool-parts.ts";
import type { LhViewMessage } from "./view.ts";

/**
 * Resolve each visited/current plan node to the best transcript message anchor
 * to teleport to ("Jump to lesson").
 *
 * For each node's FIRST stay in chronological order, returns the first
 * assistant message anchor after the previous strand's last tagged check (or
 * after plan_init for the first strand), falling back to the message carrying
 * that node's first tagged check. Upcoming nodes are omitted.
 */
export function planNodeJumpTargets(tree: PlanTree, messages: readonly LhViewMessage[]): Map<string, string> {
	const ids = new Set(tree.nodes.map((n) => n.id));
	const targets = new Map<string, string>();
	if (ids.size === 0) return targets;

	interface TextAnchor {
		eventIdx: number;
		messageId: string;
	}
	interface CheckEvent {
		eventIdx: number;
		nodeId: string;
		fallbackId: string;
	}

	const textAnchors: TextAnchor[] = [];
	const checks: CheckEvent[] = [];
	let latestPlanInitIdx = -1;
	let eventIdx = 0;

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const messageTextAnchors: string[] = [];
		for (const part of message.parts) {
			if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "" && part.id) {
				const sourceId = textPartMessageId(part.id);
				if (sourceId && !messageTextAnchors.includes(sourceId)) {
					messageTextAnchors.push(sourceId);
					textAnchors.push({ eventIdx, messageId: sourceId });
				}
			}
			if (part.type.startsWith("tool-plan_") && part.state === "output-available") {
				latestPlanInitIdx = eventIdx;
			}
			let input: unknown = part.input;
			let isPos = false;
			if (part.pluginQuestion !== undefined) {
				const snapshot = posedPluginQuestionOfPart(part);
				if (snapshot?.variant === "teach") {
					input = snapshot.input;
					isPos = true;
				}
			} else if (isPositionToolPart(part.type)) {
				isPos = true;
			}
			if (isPos) {
				const nodeId = (input as { nodeId?: unknown } | undefined)?.nodeId;
				if (typeof nodeId === "string" && ids.has(nodeId)) {
					const fallbackId =
						messageTextAnchors[0] ??
						(typeof part.sourceMessageId === "string" && part.sourceMessageId ? part.sourceMessageId : message.id);
					checks.push({ eventIdx, nodeId, fallbackId });
				}
			}
			eventIdx++;
		}
	}

	if (checks.length === 0) return targets;

	// Group consecutive checks on the same nodeId into stays, recording the
	// boundary after the previous stay (and after plan_init for the first).
	let prevStayEndIdx = latestPlanInitIdx;
	let i = 0;
	while (i < checks.length) {
		const stayNodeId = checks[i]!.nodeId;
		const firstCheck = checks[i]!;
		let lastCheck = firstCheck;
		let j = i + 1;
		while (j < checks.length && checks[j]!.nodeId === stayNodeId) {
			lastCheck = checks[j]!;
			j++;
		}
		if (!targets.has(stayNodeId)) {
			const prose =
				textAnchors.find((a) => a.eventIdx > prevStayEndIdx && a.eventIdx <= firstCheck.eventIdx) ??
				textAnchors.find((a) => a.eventIdx > firstCheck.eventIdx && a.eventIdx <= lastCheck.eventIdx);
			targets.set(stayNodeId, prose ? prose.messageId : firstCheck.fallbackId);
		}
		prevStayEndIdx = lastCheck.eventIdx;
		i = j;
	}

	return targets;
}
