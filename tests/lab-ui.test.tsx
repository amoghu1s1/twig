/**
 * TWIG LAB UI SURFACE — SSR render pins and draft-creation pins:
 * - NotebookCell (code, markdown, check, predict-before-run gate)
 * - VariableInspector (summary badge + expanded table)
 * - LabToolbar (controls & status)
 * - LabCellMutationCard (mentor tool cards)
 * - LabSettingsRows (Settings -> General Lab group)
 * - SessionRow ("lab" vs archived "capstone")
 * - DraftShell & startDraftSession (mode="lab", optional picks, workspaceDir)
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { NotebookCell } from "../components/lab/notebook-cell.tsx";
import { VariableInspector } from "../components/lab/variable-inspector.tsx";
import { LabToolbar } from "../components/lab/lab-toolbar.tsx";
import { LabMilestoneStrip } from "../components/lab/lab-milestone-strip.tsx";
import { ExtractModuleDialog } from "../components/lab/extract-module-dialog.tsx";
import { LabCellMutationCard, LabSummaryCard } from "../components/lab/lab-tool-cards.tsx";
import { LabSettingsRows } from "../components/settings/lab-rows.tsx";
import { SessionRow } from "../components/sidebar.tsx";
import { DraftShell, startDraftSession } from "../components/new-session.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import {
	hashCellSource,
	isLegacyCapstone,
	type ArtifactPartProps,
	type ChatListItem,
	type LabCell,
	type LabNotebook,
	type LabSessionMeta,
} from "../src/core";

const noop = () => {};

function baseCell(over: Partial<LabCell> = {}): LabCell {
	return {
		id: "cell_1",
		cellType: "code",
		role: "code",
		source: "x = 2 + 2\nx",
		executionCount: 1,
		outputs: [{ outputType: "execute_result", data: { "text/plain": "4" }, executionCount: 1 }],
		author: "learner",
		learnerEdited: false,
		...over,
	};
}

function item(over: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1",
		title: "NumPy Lab",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 1,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...over,
	};
}

describe("NotebookCell SSR", () => {
	it("renders code cell source, output, and Ask mentor action", () => {
		const html = renderToStaticMarkup(
			<NotebookCell
				cell={baseCell()}
				index={0}
				totalCells={1}
				language="python"
				running={false}
				onChange={noop}
				onRun={noop}
				onRunAndAdvance={noop}
				onInterrupt={noop}
				onMoveUp={noop}
				onMoveDown={noop}
				onInsertBelow={noop}
				onDelete={noop}
				onAskMentor={noop}
			/>,
		);
		assert.match(html, /x = 2 \+ 2/);
		assert.match(html, /Ask mentor/);
		assert.match(html, /lab-cell-outputs/);
	});

	it("renders markdown cell content", () => {
		const html = renderToStaticMarkup(
			<NotebookCell
				cell={baseCell({
					cellType: "markdown",
					role: "markdown",
					source: "## Matrix Multiplication\nCompute $AB$.",
					outputs: [],
					author: "mentor",
				})}
				index={0}
				totalCells={1}
				language="python"
				running={false}
				onChange={noop}
				onRun={noop}
				onRunAndAdvance={noop}
				onInterrupt={noop}
				onMoveUp={noop}
				onMoveDown={noop}
				onInsertBelow={noop}
				onDelete={noop}
				onAskMentor={noop}
			/>,
		);
		assert.match(html, /Matrix Multiplication/);
		assert.match(html, /Markdown · mentor/);
	});

	it("renders check cell status badge for passed assertions", () => {
		const html = renderToStaticMarkup(
			<NotebookCell
				cell={baseCell({
					role: "check",
					title: "Check dot product",
					author: "mentor",
					checkResult: { passed: true, summary: "Passed 2/2 checks", passedCount: 2, totalCount: 2 },
				})}
				index={1}
				totalCells={2}
				language="python"
				running={false}
				onChange={noop}
				onRun={noop}
				onRunAndAdvance={noop}
				onInterrupt={noop}
				onMoveUp={noop}
				onMoveDown={noop}
				onInsertBelow={noop}
				onDelete={noop}
				onAskMentor={noop}
			/>,
		);
		assert.match(html, /Passed 2\/2 checks/);
		assert.match(html, /Check dot product/);
		assert.match(html, /border-success\/40/);
	});

	it("locks run behind prediction prompt until learner commits", () => {
		const html = renderToStaticMarkup(
			<NotebookCell
				cell={baseCell({
					role: "predict",
					author: "mentor",
					outputs: [],
					prediction: { prompt: "What shape will a.T @ b have?", revealed: false },
				})}
				index={0}
				totalCells={1}
				language="python"
				running={false}
				onChange={noop}
				onRun={noop}
				onRunAndAdvance={noop}
				onInterrupt={noop}
				onMoveUp={noop}
				onMoveDown={noop}
				onInsertBelow={noop}
				onDelete={noop}
				onAskMentor={noop}
			/>,
		);
		assert.match(html, /What shape will a\.T @ b have\?/);
		assert.match(html, /Predict before run/);
		assert.match(html, /Lock prediction &amp; unlock Run/);
		assert.match(html, /title="Submit a prediction first"/);
		const runButton = /<button[^>]*data-testid="lab-run-cell_1"[^>]*>/.exec(html)?.[0] ?? "";
		assert.match(runButton, /\sdisabled=""/);
	});

	it("renders stale Modified pill, check cases list, preset menu, and Extract .py action", () => {
		const codeHtml = renderToStaticMarkup(
			<NotebookCell
				cell={baseCell({
					source: "def compute(x):\n    return x * 2",
					sourceHashAtRun: hashCellSource("def compute(x):\n    return x"),
					lastExecutedAt: "2026-01-02T00:00:00.000Z",
				})}
				index={0}
				totalCells={2}
				language="python"
				running={false}
				onChange={noop}
				onRun={noop}
				onRunAndAdvance={noop}
				onInterrupt={noop}
				onMoveUp={noop}
				onMoveDown={noop}
				onInsertBelow={noop}
				onDelete={noop}
				onAskMentor={noop}
				onExtractModule={noop}
			/>,
		);
		assert.match(codeHtml, /lab-stale-cell_1/);
		assert.match(codeHtml, /Modified/);
		assert.match(codeHtml, /lab-ask-presets-cell_1/);
		assert.match(codeHtml, /lab-extract-cell_1/);
		assert.match(codeHtml, /Extract \.py/);

		const checkHtml = renderToStaticMarkup(
			<NotebookCell
				cell={baseCell({
					id: "chk_1",
					role: "check",
					author: "mentor",
					source: "assert x == 4\ndef test_pos():\n    assert x > 0",
					checkResult: {
						passed: false,
						checkPassed: false,
						status: "failed",
						summary: "Passed 1/2 checks",
						passedCount: 1,
						totalCount: 2,
						cases: [
							{ name: "assert x == 4", passed: true },
							{ name: "test_pos", passed: false, message: "AssertionError" },
						],
					},
				})}
				index={1}
				totalCells={2}
				language="python"
				running={false}
				onChange={noop}
				onRun={noop}
				onRunAndAdvance={noop}
				onInterrupt={noop}
				onMoveUp={noop}
				onMoveDown={noop}
				onInsertBelow={noop}
				onDelete={noop}
				onAskMentor={noop}
			/>,
		);
		assert.match(checkHtml, /lab-check-badge-chk_1/);
		assert.match(checkHtml, /lab-check-cases-chk_1/);
		assert.match(checkHtml, /test_pos/);
		assert.match(checkHtml, /AssertionError/);

		const unrunHtml = renderToStaticMarkup(
			<NotebookCell
				cell={baseCell({
					id: "chk_unrun",
					role: "check",
					author: "mentor",
					outputs: [],
					executionCount: null,
					checkResult: undefined,
				})}
				index={0}
				totalCells={1}
				language="python"
				running={false}
				onChange={noop}
				onRun={noop}
				onRunAndAdvance={noop}
				onInterrupt={noop}
				onMoveUp={noop}
				onMoveDown={noop}
				onInsertBelow={noop}
				onDelete={noop}
				onAskMentor={noop}
			/>,
		);
		assert.match(unrunHtml, /Not run · Check cell/);
	});
});

describe("LabMilestoneStrip & ExtractModuleDialog SSR", () => {
	it("renders milestone strip summary and per-check pills", () => {
		const notebook: LabNotebook = {
			nbformat: 4,
			nbformatMinor: 5,
			language: "python",
			cells: [
				baseCell({
					id: "c1",
					source: "x = 1",
					lastExecutedAt: "2026-01-02T00:00:05.000Z",
				}),
				baseCell({
					id: "chk_pass",
					role: "check",
					title: "Imports",
					source: "assert True",
					lastExecutedAt: "2026-01-02T00:00:01.000Z",
					checkResult: { passed: true, summary: "Passed 1/1", passedCount: 1, totalCount: 1 },
				}),
				baseCell({
					id: "chk_unrun",
					role: "check",
					title: "Solver",
					source: "assert False",
					checkResult: undefined,
				}),
			],
		};
		const html = renderToStaticMarkup(
			<LabMilestoneStrip
				notebook={notebook}
				running={false}
				onJumpToCell={noop}
				onRunAllChecks={noop}
			/>,
		);
		assert.match(html, /lab-milestone-strip/);
		assert.match(html, /Milestones 0\/2/);
		assert.match(html, /lab-milestone-pill-chk_pass/);
		assert.match(html, /lab-milestone-pill-chk_unrun/);
		assert.match(html, /lab-run-all-checks/);
		assert.match(html, /Run checks/);
	});

	it("renders ExtractModuleDialog with detected symbols", () => {
		const html = renderToStaticMarkup(
			<ExtractModuleDialog
				open
				chatId="c_lab"
				cell={baseCell({ source: "def step_rk4(y, dt):\n    return y\n\nclass Solver:\n    pass" })}
				existingFiles={[{ path: "helpers.py", name: "helpers.py", sizeBytes: 120, kind: "file" }]}
				onClose={noop}
				onExtracted={noop}
			/>,
		);
		assert.match(html, /lab-extract-dialog/);
		assert.match(html, /step_rk4/);
		assert.match(html, /Solver/);
		assert.match(html, /Extract cell to \.py module/);
	});
});

describe("VariableInspector SSR", () => {
	it("renders variable summary and table rows when open", () => {
		const html = renderToStaticMarkup(
			<VariableInspector
				open
				onToggleOpen={noop}
				onRefresh={noop}
				variables={[
					{ name: "weights", typeName: "ndarray", shape: [4, 8], dtype: "float32", device: "cpu", summary: "array(...)" },
				]}
			/>,
		);
		assert.match(html, /Live Variables \(1\)/);
		assert.match(html, /weights/);
		assert.match(html, /ndarray/);
		assert.match(html, /\(4, 8\)/);
		assert.match(html, /float32 · cpu/);
	});
});

describe("LabToolbar SSR", () => {
	it("renders session title, Python interpreter pill, and actions", () => {
		const meta: LabSessionMeta = {
			language: "python",
			workspaceDir: "/home/user/Documents/Twig Labs/numpy-basics",
			notebookFile: "notebook.ipynb",
			interpreterPath: "/usr/bin/python3",
		};
		const html = renderToStaticMarkup(
			<LabToolbar
				chatId="c_lab"
				title="NumPy Basics"
				onRename={async () => {}}
				meta={meta}
				kernelStatus="idle"
				busyCellId={null}
				envs={[{ path: "/usr/bin/python3", version: "3.14.8", label: "System Python", kind: "system", packages: ["numpy", "matplotlib"] }]}
				envsLoading={false}
				filesOpen={false}
				variablesOpen={false}
				onToggleFiles={noop}
				onToggleVariables={noop}
				onRunAll={noop}
				onInterrupt={noop}
				onRestart={noop}
				onRefreshEnvs={noop}
				onSelectInterpreter={async () => {}}
				onChangeWorkspaceDir={async () => {}}
				onDownloadIpynb={noop}
				onChangeNudgeLevel={async () => {}}
				onWrapUp={noop}
			/>,
		);
		assert.match(html, /NumPy Basics/);
		assert.match(html, /Lab/);
		assert.match(html, /System Python/);
		assert.match(html, /Run All/);
		assert.match(html, /Restart/);
		assert.match(html, /Files/);
		assert.match(html, /Vars/);
		assert.match(html, /lab-nudge-picker/);
		assert.match(html, /Nudge/);
		assert.match(html, /Balanced/);
		assert.match(html, /Direct/);
		assert.match(html, /lab-wrap-up/);
		assert.match(html, /Wrap up/);
	});
});

describe("LabCellMutationCard & LabSettingsRows SSR", () => {
	const part = (tool: string, over: Partial<ArtifactPartProps["part"]> = {}): ArtifactPartProps["part"] => ({
		type: `tool-${tool}`,
		state: "output-available",
		toolCallId: "tc_1",
		...over,
	});

	it("renders jump action for mentor cell insertions and error state when refused", () => {
		const ok = renderToStaticMarkup(
			<LabCellMutationCard
				part={part("insert_cell", {
					input: { role: "check", title: "Verify shape" },
					output: { cellId: "c_2", index: 2, role: "check", title: "Verify shape" },
				})}
			/>,
		);
		assert.match(ok, /Inserted check cell #2/);
		assert.match(ok, /Verify shape/);

		const fail = renderToStaticMarkup(
			<LabCellMutationCard part={part("update_mentor_cell", { state: "output-error" })} />,
		);
		assert.match(fail, /protected or unavailable/);

		const summary = renderToStaticMarkup(
			<LabSummaryCard
				part={part("lab_summary", {
					output: {
						summary: "Completed the core integrator loop; review stability bounds next.",
						milestonesCompleted: ["Imports", "Euler step"],
						gaps: [{ area: "RK4 stability", note: "Step-size constraint dt", targets: ["n1"] }],
					},
				})}
			/>,
		);
		assert.match(summary, /lab-summary-card/);
		assert.match(summary, /Lab Wrap-Up &amp; Gaps/);
		assert.match(summary, /RK4 stability/);
		assert.match(summary, /lab-seed-teach/);
		assert.match(summary, /lab-seed-practice/);
	});

	it("renders Lab settings rows inside General", () => {
		const html = renderToStaticMarkup(
			<LabSettingsRows
				lab={{ defaultRootDir: "/home/u/Labs", pythonPath: "/usr/bin/python3", defaultNudgeLevel: "nudge" }}
				onLabChange={() => true}
			/>,
		);
		assert.match(html, /Twig Lab/);
		assert.match(html, /Default workspace folder/);
		assert.match(html, /Default Python interpreter/);
		assert.match(html, /Default coaching mode/);
		assert.match(html, /select-lab-nudge/);
	});
});

describe("Sidebar rows & Lab draft", () => {
	const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
	beforeEach(() => {
		const data = new Map<string, string>();
		Object.defineProperty(globalThis, "sessionStorage", {
			configurable: true,
			value: {
				getItem: (k: string) => data.get(k) ?? null,
				setItem: (k: string, v: string) => { data.set(k, v); },
				removeItem: (k: string) => { data.delete(k); },
			},
		});
	});
	afterEach(() => {
		if (originalStorage) Object.defineProperty(globalThis, "sessionStorage", originalStorage);
		else Reflect.deleteProperty(globalThis, "sessionStorage");
	});

	it("renders distinct badges for lab and archived capstone sidebar rows", () => {
		assert.match(
			renderToStaticMarkup(<SessionRow chat={item({ kind: "lab" })} active={false} onOpen={noop} />),
			/aria-label="Lab session"/,
		);
		assert.match(
			renderToStaticMarkup(<SessionRow chat={item({ kind: "capstone" })} active={false} onOpen={noop} />),
			/aria-label="Archived capstone session"/,
		);
		assert.equal(isLegacyCapstone("capstone"), true);
		assert.equal(isLegacyCapstone("lab"), false);
	});

	it("allows sending in Lab draft without picking any graph nodes", () => {
		const html = renderToStaticMarkup(
			<InteractionLayersProvider>
				<DraftShell
					busy={false}
					text="Explore matplotlib histograms"
					onChange={noop}
					onSend={noop}
					mode="lab"
					picks={[]}
					labWorkspaceDir=""
					onLabWorkspaceDirChange={noop}
				/>
			</InteractionLayersProvider>,
		);
		assert.match(html, /New Lab session/);
		assert.match(html, /Auto folder/);
		assert.match(html, /Pick nodes/);
		const sendButton = /<button[^>]*aria-label="Send"[^>]*>/.exec(html)?.[0] ?? "";
		assert.ok(sendButton.length > 0);
		assert.doesNotMatch(sendButton, /\sdisabled(=|\s|>)/);
	});

	it("startDraftSession sends kind: lab with optional workspaceDir", async () => {
		const calls: unknown[] = [];
		const f = (async (_u: string, init?: RequestInit) => {
			calls.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({ id: "c_lab1" }), { status: 200 });
		}) as typeof fetch;

		const url = await startDraftSession(
			"PyTorch autograd basics",
			f,
			"lab",
			[],
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			{ workspaceDir: "/tmp/my-autograd-lab" },
		);
		assert.equal(url, "/chat/c_lab1");
		assert.deepEqual(calls[0], {
			title: "PyTorch autograd basics",
			kind: "lab",
			lab: { workspaceDir: "/tmp/my-autograd-lab" },
		});
	});
});
