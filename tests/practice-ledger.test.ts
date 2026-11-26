import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { neighborContextForSelection } from "../src/core/chains.ts";
import { foldPracticeLedger, formatPracticeLedgerForPrompt } from "../src/core/practice-ledger.ts";
import { newCompactionMarker } from "../src/core/compaction.ts";
import {
	newGraphContextMessage,
	newMessageId,
	newPracticeStructuredSubmitMessage,
	newThinkingMessage,
	type LhMessage,
} from "../src/core/native-messages.ts";

describe("neighborContextForSelection (strict 1-hop chains)", () => {
	const nodes = [
		{ id: "p1", name: "Picked One", statement: "Statement P1" },
		{ id: "n1", name: "Neighbor 1", statement: "Statement N1" },
		{ id: "n2", name: "Neighbor 2", statement: "Statement N2" },
		{ id: "h2", name: "Two-Hop Node", statement: "Statement H2" },
		{ id: "same_src", name: "Unrelated Same Source", statement: "No edge touches p1" },
	];

	const chains = [
		{ id: "c1", premises: ["p1"], conclusion: "n1" },
		{ id: "c2", premises: ["n2", "n1"], conclusion: "p1" },
		{ id: "c3", premises: ["n1"], conclusion: "h2" }, // 2 hops away from p1
	];

	it("returns strict 1-hop neighbors and excludes 2-hop or disconnected nodes", () => {
		const res = neighborContextForSelection([{ id: "p1" }], nodes, chains);
		assert.deepEqual(
			res.neighbors.map((n) => n.id).sort(),
			["n1", "n2"],
		);
		assert.equal(res.neighborChains.length, 2);
		assert.ok(!res.neighbors.some((n) => n.id === "h2"));
		assert.ok(!res.neighbors.some((n) => n.id === "same_src"));
	});

	it("caps neighbors at maxNeighbors and orders deterministically by degree then id", () => {
		const manyNodes = [
			{ id: "p1", name: "Picked", statement: "Root" },
			...Array.from({ length: 16 }, (_, i) => ({
				id: `nb_${String(i).padStart(2, "0")}`,
				name: `Nb ${i}`,
				statement: `Stmt ${i}`,
			})),
		];
		const manyChains = [
			...Array.from({ length: 16 }, (_, i) => ({
				id: `edge_${i}`,
				premises: ["p1"],
				conclusion: `nb_${String(i).padStart(2, "0")}`,
			})),
			// Extra link to nb_15 so it has highest degree
			{ id: "edge_extra", premises: ["nb_15"], conclusion: "p1" },
		];
		const res = neighborContextForSelection([{ id: "p1" }], manyNodes, manyChains, 12);
		assert.equal(res.neighbors.length, 12);
		assert.equal(res.neighbors[0]!.id, "nb_15");
		const res2 = neighborContextForSelection([{ id: "p1" }], manyNodes, manyChains, 12);
		assert.deepEqual(res, res2);
	});
});

function poseCall(id: string, name: string, args: Record<string, unknown>, ok = true): LhMessage[] {
	return [
		{
			id: newMessageId(),
			role: "assistant",
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 1,
			content: [{ type: "toolCall", id, name, arguments: args as never }],
		},
		{
			id: newMessageId(),
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			content: [{ type: "text", text: "ok" }],
			isError: !ok,
			timestamp: 2,
		},
	];
}

function concludeCall(id: string, args: Record<string, unknown>): LhMessage[] {
	return [
		{
			id: newMessageId(),
			role: "assistant",
			api: "faux",
			provider: "faux",
			model: "faux",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: 3,
			content: [{ type: "toolCall", id, name: "conclude", arguments: args as never }],
		},
		{
			id: newMessageId(),
			role: "toolResult",
			toolCallId: id,
			toolName: "conclude",
			content: [{ type: "text", text: "Concluded." }],
			isError: false,
			timestamp: 4,
		},
	];
}

describe("foldPracticeLedger & formatPracticeLedgerForPrompt", () => {
	it("tracks targets, modes, retest queue add/clear, voided exclusion, and survives compaction", () => {
		const seed = newGraphContextMessage(
			[
				{ id: "t1", name: "Group order", statement: "Orders divide |G|" },
				{ id: "t2", name: "Cosets", statement: "Cosets partition G" },
			],
			[],
		);

		const messages: LhMessage[] = [
			seed,
			// Problem 1: missed/surrendered with retest: true on t1
			...poseCall("p1", "problem", { statement: "First problem on t1", mode: "recall", target: ["t1"], modelSolution: "S" }),
			newThinkingMessage("p1", "hint pls", undefined, "hint"),
			newThinkingMessage("p1", "my try", undefined, "submit"),
			...concludeCall("c1", { outcome: "surrendered", verdict: "Missed.", rung: "R3", missClass: "wrongMethod", retest: true }),
			// Compaction cut happens mid-session
			newCompactionMarker("Compacted", { firstKeptMessageId: seed.id, tokensBefore: 1000, at: new Date(1000).toISOString() }),
			// Problem 2: voided question on t2 — must NOT mark t2 tested or increment problemsAttempted
			...poseCall("p2", "practice_check", { statement: "Bad question", mode: "discrimination", target: ["t2"], modelSolution: "S", options: [{ label: "A" }, { label: "B" }], correctAnswer: "A" }),
			newThinkingMessage("p2", "", undefined, "flag-bad"),
			...concludeCall("c2", { outcome: "voided", verdict: "Malformed.", rung: null, missClass: null, retest: false }),
			// Problem 3: fresh retest on t1 solved cleanly — clears t1 retestQueue
			...poseCall("p3", "practice_match", { statement: "Retest t1", mode: "discrimination", target: ["t1"], modelSolution: "S", categories: [{ id: "c", label: "C" }, { id: "d", label: "D" }], items: [{ id: "i", prompt: "P" }], correctMapping: { i: "c" } }),
			newPracticeStructuredSubmitMessage({ problemCallId: "p3", format: "match", payload: {}, passed: true, summaryText: "Matched 1/1" }),
			...concludeCall("c3", { outcome: "solved", verdict: "Clean.", rung: null, missClass: null, retest: false }),
			// Problem 4 (currently active): 2 attempts + 1 hint
			...poseCall("p4", "problem", { statement: "Coset proof", mode: "composition", target: ["t2"], modelSolution: "S" }),
			newThinkingMessage("p4", "attempt 1", undefined, "submit"),
			newThinkingMessage("p4", "", undefined, "hint"),
			newThinkingMessage("p4", "attempt 2", undefined, "submit"),
		];

		const ledger = foldPracticeLedger(messages);
		assert.equal(ledger.problemsAttempted, 2);
		assert.equal(ledger.problemsSolved, 1);
		assert.equal(ledger.problemsRevealed, 1);
		assert.equal(ledger.problemsVoided, 1);
		assert.equal(ledger.retestQueue.length, 0);

		const t1 = ledger.targets.find((t) => t.id === "t1")!;
		assert.equal(t1.status, "solid");
		assert.deepEqual(t1.modesTested, ["recall", "discrimination"]);
		assert.equal(t1.needsRetest, false);
		assert.equal(t1.highestRung, 3);

		const t2 = ledger.targets.find((t) => t.id === "t2")!;
		assert.equal(t2.status, "untested");
		assert.equal(t2.attempts, 0);

		assert.deepEqual(ledger.activeProblem, {
			toolCallId: "p4",
			toolName: "problem",
			attempts: 2,
			hints: 1,
		});

		const formatted = formatPracticeLedgerForPrompt(ledger, {
			coaching: "balanced",
			depth: "deep",
			presentation: "theory",
			verifySolutions: true,
		});
		assert.match(formatted, /Coaching = BALANCED/);
		assert.match(formatted, /2\+ attempts\/hints on this active problem/);
		assert.match(formatted, /Depth = DEEP MULTI-STEP/);
		assert.match(formatted, /Style = THEORY/);
		assert.match(formatted, /\[t1\] Group order: solid/);
	});
});
