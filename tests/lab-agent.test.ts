import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore } from "@earendil-works/pi-ai";
import type { PiEngine } from "../src/agent/models.ts";
import { createEmptyLabNotebook, type GraphNode, type LabNotebook, type LabNudgeLevel, type LhMessage } from "../src/core/index.ts";
import { listSourceSegments } from "../src/agent/prompt-segments.ts";
import { composeInstructions, createLabAgent } from "../src/agent/teacher-agent.ts";
import { labTools } from "../src/agent/tools/lab.ts";

const TMP_DIR = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lh-lab-agent-")));
const OUTSIDE_FILE = path.join(TMP_DIR, "outside.txt");
const WORKSPACE_DIR = path.join(TMP_DIR, "workspace");
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
fs.writeFileSync(OUTSIDE_FILE, "top-secret", "utf-8");
fs.writeFileSync(path.join(WORKSPACE_DIR, "helpers.py"), "VALUE = 7\n", "utf-8");

after(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

function makeHarness(
	initialNotebook?: LabNotebook,
	opts: {
		supportsImages?: boolean;
		nudgeLevel?: LabNudgeLevel;
		messages?: LhMessage[];
		nodes?: Array<Pick<GraphNode, "id" | "name" | "statement">>;
	} = {},
) {
	let notebook: LabNotebook = initialNotebook ?? createEmptyLabNotebook("Lab Agent Test");
	let rev = "rev_1";
	const events: Array<{ revision?: string; focusCellId?: string }> = [];

	const tools = labTools({
		chatId: "chat_lab_1",
		supportsImages: opts.supportsImages ?? true,
		getNudgeLevel: () => opts.nudgeLevel ?? "nudge",
		getMessages: () => opts.messages ?? [],
		graphNodes: () => opts.nodes ?? [{ id: "n_broadcast", name: "NumPy Broadcasting", statement: "Trailing axes align." }],
		readNotebook: async () => ({ notebook: structuredClone(notebook), revision: rev }),
		writeNotebook: async (next) => {
			notebook = structuredClone(next);
			rev = `rev_${Number(rev.split("_")[1]) + 1}`;
			return { revision: rev };
		},
		inspectVariables: async () => [
			{ name: "W", typeName: "ndarray", shape: [3, 2], dtype: "float32", summary: "ndarray(3, 2) float32" },
		],
		getWorkspaceRoot: async () => WORKSPACE_DIR,
		emitLabChanged: (payload) => events.push(payload),
	});

	return {
		tools,
		getNotebook: () => notebook,
		events,
	};
}

describe("lab agent tools", () => {
	it("reads notebook contents and attaches PNG images only when model supports images", async () => {
		const nb = createEmptyLabNotebook("Plots");
		nb.cells[1]!.outputs = [
			{ outputType: "display_data", data: { "image/png": "ZmFrZXBuZw==" } },
		];

		const withVision = makeHarness(nb, { supportsImages: true });
		const resVision = await withVision.tools.read_notebook!.execute("tc1", { includeImages: true });
		assert.equal(resVision.content.some((p) => p.type === "image" && p.data === "ZmFrZXBuZw=="), true);

		const textOnly = makeHarness(nb, { supportsImages: false });
		const resText = await textOnly.tools.read_notebook!.execute("tc2", { includeImages: true });
		assert.equal(resText.content.some((p) => p.type === "image"), false);
		assert.match((resText.content[0] as { text: string }).text, /omitted because the active model does not accept image input/);
	});

	it("inspects live kernel variables", async () => {
		const h = makeHarness();
		const res = await h.tools.inspect_variables!.execute("tc1", {});
		const text = (res.content[0] as { text: string }).text;
		assert.match(text, /W: ndarray/);
		assert.match(text, /shape=\(3, 2\)/);
		assert.match(text, /dtype=float32/);
	});

	it("inserts code/check/predict cells stamped as mentor and emits lab-changed", async () => {
		const h = makeHarness();
		const starterCodeId = h.getNotebook().cells[1]!.id;

		// Predict cell without predictionPrompt is rejected
		const badPredict = await h.tools.insert_cell!.execute("tc_bad", {
			cellType: "code",
			role: "predict",
			source: "x = [1, 2]\nx * 2",
		});
		assert.equal(badPredict.isError, true);

		// Valid check cell inserted after starter cell
		const okInsert = await h.tools.insert_cell!.execute("tc_ok", {
			cellType: "code",
			role: "check",
			title: "Verify shape",
			afterCellId: starterCodeId,
			source: "assert W.shape == (3, 2)",
		});
		assert.equal(okInsert.isError, undefined);
		const insertedCell = h.getNotebook().cells[2]!;
		assert.equal(insertedCell.author, "mentor");
		assert.equal(insertedCell.learnerEdited, false);
		assert.equal(insertedCell.role, "check");
		assert.equal(h.events.length, 1);
		assert.equal(h.events[0]?.focusCellId, insertedCell.id);
	});

	it("updates and deletes unedited mentor cells, but hard-refuses learner-owned or learner-edited cells", async () => {
		const h = makeHarness();
		const learnerCellId = h.getNotebook().cells[1]!.id;

		// Learner cell cannot be updated or deleted
		const updLearner = await h.tools.update_mentor_cell!.execute("tc1", {
			cellId: learnerCellId,
			source: "hijacked = True",
		});
		assert.equal(updLearner.isError, true);
		assert.match((updLearner.content[0] as { text: string }).text, /owned or edited by the learner/);

		const delLearner = await h.tools.delete_mentor_cell!.execute("tc2", { cellId: learnerCellId });
		assert.equal(delLearner.isError, true);

		// Insert mentor cell -> can update while learnerEdited === false
		const ins = await h.tools.insert_cell!.execute("tc3", {
			cellType: "code",
			role: "code",
			source: "# step 1",
		});
		const mentorId = (ins.details as { cellId: string }).cellId;
		const updMentor = await h.tools.update_mentor_cell!.execute("tc4", {
			cellId: mentorId,
			source: "# step 1 updated",
		});
		assert.equal(updMentor.isError, undefined);
		assert.equal(h.getNotebook().cells.find((c) => c.id === mentorId)?.source, "# step 1 updated");

		// Flip learnerEdited = true -> subsequent mentor update/delete must be refused
		const cell = h.getNotebook().cells.find((c) => c.id === mentorId)!;
		cell.learnerEdited = true;
		const updAfterEdit = await h.tools.update_mentor_cell!.execute("tc5", {
			cellId: mentorId,
			source: "# overwrite attempt",
		});
		assert.equal(updAfterEdit.isError, true);
		const delAfterEdit = await h.tools.delete_mentor_cell!.execute("tc6", { cellId: mentorId });
		assert.equal(delAfterEdit.isError, true);

		// Unedited mentor cell can be deleted
		cell.learnerEdited = false;
		const delOk = await h.tools.delete_mentor_cell!.execute("tc7", { cellId: mentorId });
		assert.equal(delOk.isError, undefined);
		assert.equal(h.getNotebook().cells.some((c) => c.id === mentorId), false);
	});

	it("confines scoped file tools to workspaceDir", async () => {
		const h = makeHarness();
		const inside = await h.tools.read!.execute("tc1", { path: "helpers.py" });
		assert.match((inside.content[0] as { text: string }).text, /VALUE = 7/);

		await assert.rejects(
			() => h.tools.read!.execute("tc2", { path: "../outside.txt" }),
			/outside/i,
		);
	});

	it("surfaces structured check milestones & pointer_only vs escalate_ok coaching tags in read_notebook", async () => {
		const nb = createEmptyLabNotebook("Nudge Test");
		nb.cells[1]!.outputs = [{ outputType: "error", ename: "SyntaxError", evalue: "bad", traceback: ["SyntaxError: bad"] }];
		nb.cells[1]!.failedRunCount = 1;
		nb.cells.push({
			id: "chk_milestone",
			cellType: "code",
			role: "check",
			author: "mentor",
			learnerEdited: false,
			title: "Step 1 Check",
			source: "assert True",
			executionCount: null,
			outputs: [],
		});

		const hFirst = makeHarness(nb, { nudgeLevel: "nudge", messages: [] });
		const r1 = await hFirst.tools.read_notebook!.execute("tc1", {});
		const t1 = (r1.content[0] as { text: string }).text;
		assert.match(t1, /Coaching mode: nudge/);
		assert.match(t1, /coaching=pointer_only/);
		assert.match(t1, /Check status: NOT_RUN \(checkPassed=false\)/);
		assert.equal((r1.details as { milestones: { total: number; notRun: number } }).milestones.total, 1);
		assert.equal((r1.details as { milestones: { total: number; notRun: number } }).milestones.notRun, 1);

		const priorMsgs: LhMessage[] = [
			{ id: "u1", role: "user", content: `Help with ${nb.cells[1]!.id}`, timestamp: 1 },
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "text", text: "Check syntax on line 1." }],
				api: "faux",
				provider: "test",
				model: "m",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: 2,
			},
		];
		const hSecond = makeHarness(nb, { nudgeLevel: "nudge", messages: priorMsgs });
		const r2 = await hSecond.tools.read_notebook!.execute("tc2", {});
		assert.match((r2.content[0] as { text: string }).text, /coaching=escalate_ok/);
	});

	it("validates lab_summary targets against real graph nodes without mutating the graph", async () => {
		const h = makeHarness();
		const bad = await h.tools.lab_summary!.execute("s1", {
			summary: "Built step 1",
			gaps: [{ area: "Fake", note: "Invented node", targets: ["does_not_exist"] }],
		});
		assert.equal(bad.isError, true);

		const ok = await h.tools.lab_summary!.execute("s2", {
			summary: "Built step 1",
			milestonesCompleted: ["Check 1"],
			gaps: [{ area: "Broadcasting", note: "Shape mismatch", targets: ["NumPy Broadcasting"] }],
		});
		assert.equal(ok.isError, undefined);
		assert.deepEqual((ok.details as { gaps: Array<{ targets: string[] }> }).gaps[0]?.targets, ["n_broadcast"]);
	});
});

describe("lab prompt composition", () => {
	it("composes only lab/ plus voice, accuracy, and formatting, and injects active nudge banner", () => {
		assert.deepEqual(
			listSourceSegments("lab").map((s) => s.path),
			["lab/00-base.md", "lab/10-doctrine.md", "shared/10-voice.md", "shared/15-accuracy.md", "shared/40-formatting.md"],
		);
		const prompt = composeInstructions("lab");
		assert.match(prompt, /Twig Lab/);
		assert.match(prompt, /Guided Lab Method/);

		const faux = createFauxCore({});
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple } as PiEngine;
		const agent = createLabAgent(
			{
				chatId: "c1",
				getNudgeLevel: () => "direct",
				readNotebook: async () => ({ notebook: createEmptyLabNotebook("X"), revision: "r1" }),
				writeNotebook: async () => ({ revision: "r2" }),
				inspectVariables: async () => [],
				getWorkspaceRoot: async () => WORKSPACE_DIR,
				emitLabChanged: () => {},
			},
			{ engine },
		);
		assert.match(agent.state.systemPrompt, /Active session coaching mode: DIRECT/);
	});
});
