import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planNodeJumpTargets, type LhViewMessage, type PlanTree } from "../src/core/index.ts";

const tree: PlanTree = {
	nodes: [
		{ id: "n1", title: "Vectors" },
		{ id: "n2", title: "Partial derivatives" },
		{ id: "n3", title: "Divergence theorem" },
	],
	edges: [
		{ from: "n1", to: "n2" },
		{ from: "n2", to: "n3" },
	],
	version: 1,
};

function assistantMsg(id: string, parts: LhViewMessage["parts"]): LhViewMessage {
	return { id, role: "assistant", parts };
}

describe("planNodeJumpTargets", () => {
	it("maps visited and current strands to the first prose after the prior strand's check (and after plan_init)", () => {
		const messages: LhViewMessage[] = [
			assistantMsg("probe_1", [{ type: "text", id: "probe_1-t0", text: "What do you know?" }]),
			assistantMsg("plan_msg", [
				{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } },
				{ type: "text", id: "teach_n1-t0", text: "Let us start with vectors." },
				{ type: "tool-quiz", state: "output-available", input: { nodeId: "n1" }, output: { correct: true } },
				{ type: "text", id: "teach_n1_more-t0", text: "Another check on vectors." },
				{ type: "tool-quiz", state: "output-available", input: { nodeId: "n1" }, output: { correct: true } },
			]),
			assistantMsg("n2_msg", [
				{ type: "text", id: "teach_n2-t0", text: "Now onto partial derivatives." },
				{ type: "tool-explain", state: "input-available", input: { nodeId: "n2" } },
			]),
		];

		const targets = planNodeJumpTargets(tree, messages);
		assert.equal(targets.get("n1"), "teach_n1");
		assert.equal(targets.get("n2"), "teach_n2");
		assert.equal(targets.has("n3"), false, "upcoming node has no jump target");
	});

	it("keeps the first stay's anchor when a strand is revisited", () => {
		const messages: LhViewMessage[] = [
			assistantMsg("m1", [
				{ type: "tool-plan_init", state: "output-available", output: { ok: true, tree } },
				{ type: "text", id: "first_n1-t0", text: "Initial vectors lesson." },
				{ type: "tool-quiz", state: "output-available", input: { nodeId: "n1" } },
			]),
			assistantMsg("m2", [
				{ type: "text", id: "first_n2-t0", text: "Partials." },
				{ type: "tool-quiz", state: "output-available", input: { nodeId: "n2" } },
			]),
			assistantMsg("m3", [
				{ type: "text", id: "revisit_n1-t0", text: "Revisiting vectors." },
				{ type: "tool-quiz", state: "input-available", input: { nodeId: "n1" } },
			]),
		];
		const targets = planNodeJumpTargets(tree, messages);
		assert.equal(targets.get("n1"), "first_n1");
		assert.equal(targets.get("n2"), "first_n2");
	});

	it("falls back to sourceMessageId when a check has no preceding prose in its stay", () => {
		const messages: LhViewMessage[] = [
			assistantMsg("m1", [
				{ type: "tool-quiz", state: "output-available", sourceMessageId: "raw_msg_1", input: { nodeId: "n1" } },
			]),
		];
		const targets = planNodeJumpTargets(tree, messages);
		assert.equal(targets.get("n1"), "raw_msg_1");
	});
});
