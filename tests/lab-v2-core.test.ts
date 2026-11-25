import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildImportStatement,
	buildLabSeededRequest,
	computeCellCoachingStage,
	countPriorMentorNudges,
	createEmptyLabNotebook,
	extractTopLevelPythonSymbols,
	formatNudgeGuidanceBanner,
	hashCellSource,
	isCellStale,
	parseIpynb,
	parseLabSummaryInput,
	serializeIpynb,
	suggestModuleFilename,
	summarizeLabChecks,
	summarizeNotebookForModel,
	type GraphNode,
	type LhMessage,
} from "../src/core/index.ts";

describe("lab-nudge coaching stage", () => {
	it("restricts nudge mode first response to pointer_only and escalates on retry or prior nudge", () => {
		assert.equal(
			computeCellCoachingStage({ nudgeLevel: "nudge", failedRunCount: 1, priorMentorNudges: 0 }),
			"pointer_only",
		);
		assert.equal(
			computeCellCoachingStage({ nudgeLevel: "nudge", failedRunCount: 2, priorMentorNudges: 0 }),
			"escalate_ok",
		);
		assert.equal(
			computeCellCoachingStage({ nudgeLevel: "nudge", failedRunCount: 1, priorMentorNudges: 1 }),
			"escalate_ok",
		);
		assert.equal(
			computeCellCoachingStage({ nudgeLevel: "balanced", failedRunCount: 1, priorMentorNudges: 0 }),
			"escalate_ok",
		);
		assert.equal(
			computeCellCoachingStage({ nudgeLevel: "direct", failedRunCount: 1, priorMentorNudges: 0 }),
			"direct",
		);
	});

	it("counts prior mentor nudges on failing cell and resets after a passing read", () => {
		const messages: LhMessage[] = [
			{ id: "u1", role: "user", content: "Check cell_4", timestamp: 1 },
			{
				id: "tr1",
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read_notebook",
				content: [{ type: "text", text: "--- Cell 4 [1] (id=cell_4, role=check) ---\nCheck status: PASSED" }],
				details: null,
				isError: false,
				timestamp: 2,
			},
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "text", text: "Looks good!" }],
				api: "faux",
				provider: "test",
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 3,
			},
			{ id: "u2", role: "user", content: "In Cell 4 (id: cell_4), I hit an error", timestamp: 4 },
			{
				id: "tr2",
				role: "toolResult",
				toolCallId: "tc2",
				toolName: "read_notebook",
				content: [{ type: "text", text: "--- Cell 4 [2] (id=cell_4, role=code) ---\nerror:\nSyntaxError" }],
				details: null,
				isError: false,
				timestamp: 5,
			},
			{
				id: "a2",
				role: "assistant",
				content: [{ type: "text", text: "Check the colon on line 3." }],
				api: "faux",
				provider: "test",
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 6,
			},
		];
		assert.equal(countPriorMentorNudges(messages, "cell_4"), 1);
		assert.equal(countPriorMentorNudges(messages, "cell_other"), 0);
		assert.match(formatNudgeGuidanceBanner("nudge"), /NUDGE FIRST/);
	});
});

describe("lab-python extraction & hashing", () => {
	it("extracts public top-level classes/functions and builds clean import statements", () => {
		const code = [
			"def _private_helper(): pass",
			"class LiftCar:",
			"    pass",
			"async def step_tick():",
			"    pass",
		].join("\n");
		const symbols = extractTopLevelPythonSymbols(code);
		assert.deepEqual(symbols, ["LiftCar", "step_tick"]);
		assert.equal(suggestModuleFilename(code), "lift_car.py");
		assert.equal(buildImportStatement("sim/lift_car.py", symbols), "from sim.lift_car import LiftCar, step_tick");
		assert.equal(buildImportStatement("bad-name.py", symbols), "# Saved to bad-name.py");
		assert.equal(hashCellSource("x = 1"), hashCellSource("x = 1"));
		assert.notEqual(hashCellSource("x = 1"), hashCellSource("x = 2"));
	});
});

describe("lab stale detection, check rollup & v1 compat", () => {
	it("detects edited code cells, upstream invalidation of passing checks, and hydrates v1 checkResult", () => {
		const nb = createEmptyLabNotebook("Stale Test");
		nb.cells[1]!.source = "x = 1";
		nb.cells[1]!.sourceHashAtRun = hashCellSource("x = 1");
		nb.cells[1]!.lastExecutedAt = "2026-11-24T01:00:00.000Z";
		nb.cells.push({
			id: "chk_1",
			cellType: "code",
			role: "check",
			author: "mentor",
			learnerEdited: false,
			title: "Milestone 1",
			source: "assert x == 1",
			executionCount: 1,
			outputs: [],
			sourceHashAtRun: hashCellSource("assert x == 1"),
			lastExecutedAt: "2026-11-24T01:01:00.000Z",
			checkResult: {
				passed: true,
				checkPassed: true,
				status: "passed",
				summary: "1/1 checks passed",
				passedCount: 1,
				totalCount: 1,
				cases: [{ name: "assert x == 1", passed: true, line: 1 }],
				ranAt: "2026-11-24T01:01:00.000Z",
			},
		});
		nb.cells.push({
			id: "chk_2",
			cellType: "code",
			role: "check",
			author: "mentor",
			learnerEdited: false,
			title: "Milestone 2",
			source: "assert x == 2",
			executionCount: null,
			outputs: [],
		});

		assert.equal(isCellStale(nb.cells[1]!, nb), false);
		let roll = summarizeLabChecks(nb);
		assert.equal(roll.total, 2);
		assert.equal(roll.passed, 1);
		assert.equal(roll.notRun, 1);
		assert.equal(roll.checks[0]?.checkPassed, true);
		assert.equal(roll.checks[1]?.status, "not_run");
		assert.equal(roll.checks[1]?.checkPassed, false);

		// Edit code cell without re-running -> both code cell and downstream check become stale
		nb.cells[1]!.source = "x = 99";
		assert.equal(isCellStale(nb.cells[1]!, nb), true);
		roll = summarizeLabChecks(nb);
		assert.equal(roll.stale, 1);
		assert.equal(roll.checks[0]?.status, "stale");
		assert.equal(roll.checks[0]?.checkPassed, false);

		// Round-trip through ipynb
		const reparsed = parseIpynb(serializeIpynb(nb));
		assert.equal(reparsed.cells[2]?.checkResult?.cases?.length, 1);
		const modelText = summarizeNotebookForModel(nb, { nudgeLevel: "nudge" });
		assert.match(modelText, /Coaching mode: nudge/);
		assert.match(modelText, /Milestones \/ Checks:/);
		assert.match(modelText, /stale=true/);
		assert.match(modelText, /Check status: NOT_RUN \(checkPassed=false\)/);
	});
});

describe("lab-summary parser & seeded handoffs", () => {
	it("parses valid summary payloads and builds seeded teach/practice requests", () => {
		const parsed = parseLabSummaryInput({
			summary: "Built lift motion and verified clamping.",
			milestonesCompleted: ["Step 1"],
			gaps: [{ area: "Lookahead scheduling", note: "Edge case when idle at top floor", targets: ["n_scan", "missing"] }],
		});
		assert.ok(parsed);
		assert.equal(parsed.milestonesCompleted.length, 1);

		const nodes: Array<Pick<GraphNode, "id" | "name" | "statement">> = [
			{ id: "n_scan", name: "LOOK Algorithm", statement: "Sweep elevator up then down." },
		];
		const req = buildLabSeededRequest(parsed.gaps, "practice", nodes);
		assert.equal(req.kind, "practice");
		assert.equal(req.title, "Revisit: Lookahead scheduling");
		assert.equal(req.graphContext?.propositions.length, 1);
		assert.equal(req.graphContext?.propositions[0]?.id, "n_scan");
	});
});
