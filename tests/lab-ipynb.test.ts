import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createEmptyLabNotebook,
	parseIpynb,
	sanitizeLabHtmlOutput,
	serializeIpynb,
	slugifyLabFolderName,
	summarizeNotebookForModel,
	type LabNotebook,
} from "../src/core/index.ts";

describe("lab-ipynb codec", () => {
	it("creates an empty starter notebook and round-trips through nbformat 4.5 JSON", () => {
		const starter = createEmptyLabNotebook("Gradient Descent Lab");
		assert.equal(starter.nbformat, 4);
		assert.equal(starter.nbformatMinor, 5);
		assert.equal(starter.language, "python");
		assert.equal(starter.cells.length, 2);
		assert.equal(starter.cells[0]?.cellType, "markdown");
		assert.equal(starter.cells[1]?.cellType, "code");

		const json = serializeIpynb(starter);
		const parsed = JSON.parse(json) as { nbformat: number; nbformat_minor: number; cells: Array<{ source: string[] }> };
		assert.equal(parsed.nbformat, 4);
		assert.equal(parsed.nbformat_minor, 5);
		assert.deepEqual(parsed.cells[0]?.source, ["# Gradient Descent Lab\n"]);

		const back = parseIpynb(json);
		assert.equal(back.cells.length, 2);
		assert.equal(back.cells[0]?.id, starter.cells[0]?.id);
		assert.equal(back.cells[0]?.source, "# Gradient Descent Lab\n");
		assert.equal(back.cells[1]?.id, starter.cells[1]?.id);
		assert.equal(back.cells[1]?.source, "");
	});

	it("preserves Twig role/author/check/prediction metadata and unknown Jupyter metadata", () => {
		const notebook: LabNotebook = {
			nbformat: 4,
			nbformatMinor: 5,
			language: "python",
			extraMetadata: {
				colab: { name: "custom-colab-tag" },
				kernelspec: { name: "python3", display_name: "Python 3 (.venv)", language: "python" },
			},
			cells: [
				{
					id: "c_predict",
					cellType: "code",
					role: "predict",
					author: "mentor",
					learnerEdited: false,
					title: "Broadcasting shape",
					source: "import numpy as np\n(np.ones((3, 1)) + np.ones((1, 4))).shape",
					executionCount: 1,
					durationMs: 12,
					outputs: [
						{ outputType: "execute_result", executionCount: 1, data: { "text/plain": "(3, 4)" } },
					],
					prediction: {
						prompt: "What shape will adding (3, 1) and (1, 4) produce?",
						answer: "(3, 4)",
						submittedAt: "2026-11-23T12:00:00Z",
						revealed: true,
					},
					extraMetadata: { collapsed: false },
				},
				{
					id: "c_check",
					cellType: "code",
					role: "check",
					author: "mentor",
					learnerEdited: false,
					source: "assert (3, 4) == (3, 4)",
					executionCount: 2,
					outputs: [],
					checkResult: { passed: true, summary: "1/1 assertions passed", passedCount: 1, totalCount: 1 },
				},
			],
		};

		const raw = serializeIpynb(notebook);
		const parsed = parseIpynb(raw);

		assert.deepEqual(parsed.extraMetadata?.colab, { name: "custom-colab-tag" });
		assert.equal(parsed.cells[0]?.role, "predict");
		assert.equal(parsed.cells[0]?.author, "mentor");
		assert.equal(parsed.cells[0]?.learnerEdited, false);
		assert.equal(parsed.cells[0]?.prediction?.answer, "(3, 4)");
		assert.deepEqual(parsed.cells[0]?.extraMetadata, { collapsed: false });
		assert.equal(parsed.cells[1]?.role, "check");
		assert.deepEqual(parsed.cells[1]?.checkResult, {
			passed: true,
			checkPassed: true,
			status: "passed",
			summary: "1/1 assertions passed",
			passedCount: 1,
			totalCount: 1,
		});
	});

	it("parses external Jupyter .ipynb files with string sources and missing cell ids", () => {
		const external = JSON.stringify({
			nbformat: 4,
			nbformat_minor: 2,
			metadata: { custom_flag: true },
			cells: [
				{
					cell_type: "markdown",
					metadata: {},
					source: "## External Notes\nHello",
				},
				{
					cell_type: "code",
					execution_count: 5,
					metadata: { tags: ["parameters"] },
					source: ["x = 42\n", "x"],
					outputs: [
						{ output_type: "stream", name: "stdout", text: ["hello\n", "world\n"] },
						{ output_type: "error", ename: "ValueError", evalue: "bad", traceback: ["\u001b[31mValueError\u001b[0m: bad"] },
					],
				},
			],
		});

		const parsed = parseIpynb(external);
		assert.equal(parsed.cells.length, 2);
		assert.equal(parsed.cells[0]?.id, "cell_1");
		assert.equal(parsed.cells[0]?.author, "learner");
		assert.equal(parsed.cells[1]?.id, "cell_2");
		assert.equal(parsed.cells[1]?.source, "x = 42\nx");
		assert.equal(parsed.cells[1]?.executionCount, 5);
		assert.deepEqual(parsed.cells[1]?.extraMetadata, { tags: ["parameters"] });
		assert.equal(parsed.cells[1]?.outputs.length, 2);
	});

	it("summarizes notebooks for the AI mentor with truncated outputs and image markers", () => {
		const nb: LabNotebook = {
			nbformat: 4,
			nbformatMinor: 5,
			language: "python",
			cells: [
				{
					id: "c1",
					cellType: "code",
					role: "code",
					author: "learner",
					learnerEdited: true,
					source: "print('hi' * 100)",
					executionCount: 1,
					durationMs: 9,
					outputs: [
						{ outputType: "stream", name: "stdout", text: "a".repeat(200) },
						{ outputType: "display_data", data: { "image/png": "iVBOR..." } },
					],
				},
			],
		};

		const digest = summarizeNotebookForModel(nb, { maxOutputChars: 50 });
		assert.match(digest, /Cell 1 \[1\] \(id=c1, role=code, author=learner, 9ms\)/);
		assert.match(digest, /\[truncated 150 chars\]/);
		assert.match(digest, /\[image\/png output attached\/rendered\]/);
	});

	it("slugifies folder names and strips active tags/handlers from HTML outputs", () => {
		assert.equal(slugifyLabFolderName("NumPy Broadcasting & PyTorch!!"), "numpy-broadcasting-pytorch");
		assert.equal(slugifyLabFolderName("   "), "lab");

		const dirty = '<table><tr><td onclick="alert(1)"><a href="javascript:evil()">x</a></td></tr></table><script>steal()</script><style>body{}</style>';
		const clean = sanitizeLabHtmlOutput(dirty);
		assert.equal(clean.includes("<script"), false);
		assert.equal(clean.includes("<style"), false);
		assert.equal(clean.includes("onclick"), false);
		assert.equal(clean.includes("javascript:"), false);
		assert.match(clean, /<table>.*<td>.*<\/table>/);
	});
});
