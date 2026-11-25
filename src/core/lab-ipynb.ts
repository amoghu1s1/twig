/**
 * Pure nbformat v4.5 parser, serializer, model digest formatter, and HTML
 * output sanitizer for Twig Lab notebooks. Browser-safe (zero node:* imports).
 */

import type {
	LabCell,
	LabCellAuthor,
	LabCellRole,
	LabCheckCase,
	LabCheckCellStatus,
	LabCheckResult,
	LabCheckStatus,
	LabLanguage,
	LabMilestoneSummary,
	LabNotebook,
	LabNudgeLevel,
	LabOutput,
	LabPredictionState,
} from "./contracts/lab.ts";
import { computeCellCoachingStage, isCellFailing } from "./lab-nudge.ts";
import { hashCellSource } from "./lab-python.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function joinLines(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string").join("");
	return "";
}

function splitLines(text: string): string[] {
	if (text === "") return [];
	const parts = text.split("\n");
	return parts.map((line, idx) => (idx < parts.length - 1 ? `${line}\n` : line)).filter((line, idx, arr) => {
		// If text ended with "\n", split produces a trailing "" element after a line already ending in "\n".
		return !(idx === arr.length - 1 && line === "");
	});
}

function normalizeMimeData(rawData: unknown): Record<string, string> {
	const rec = asRecord(rawData);
	if (!rec) return {};
	const out: Record<string, string> = {};
	for (const [mime, value] of Object.entries(rec)) {
		if (typeof value === "string") out[mime] = value;
		else if (Array.isArray(value)) out[mime] = value.filter((v): v is string => typeof v === "string").join("");
	}
	return out;
}

function parseOutput(raw: unknown): LabOutput | null {
	const rec = asRecord(raw);
	if (!rec) return null;
	const outputType = rec.output_type;
	if (outputType === "stream") {
		const name = rec.name === "stderr" ? "stderr" : "stdout";
		return {
			outputType: "stream",
			name,
			text: joinLines(rec.text),
		};
	}
	if (outputType === "display_data") {
		const metadata = asRecord(rec.metadata) ?? undefined;
		return {
			outputType: "display_data",
			data: normalizeMimeData(rec.data),
			...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
		};
	}
	if (outputType === "execute_result") {
		const executionCount = typeof rec.execution_count === "number" ? rec.execution_count : null;
		const metadata = asRecord(rec.metadata) ?? undefined;
		return {
			outputType: "execute_result",
			executionCount,
			data: normalizeMimeData(rec.data),
			...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
		};
	}
	if (outputType === "error") {
		const traceback = Array.isArray(rec.traceback)
			? rec.traceback.filter((line): line is string => typeof line === "string")
			: [];
		return {
			outputType: "error",
			ename: typeof rec.ename === "string" ? rec.ename : "Error",
			evalue: typeof rec.evalue === "string" ? rec.evalue : "",
			traceback,
		};
	}
	return null;
}

function serializeOutput(output: LabOutput): Record<string, unknown> {
	switch (output.outputType) {
		case "stream":
			return {
				output_type: "stream",
				name: output.name,
				text: splitLines(output.text),
			};
		case "display_data":
			return {
				output_type: "display_data",
				data: output.data,
				metadata: output.metadata ?? {},
			};
		case "execute_result":
			return {
				output_type: "execute_result",
				execution_count: output.executionCount,
				data: output.data,
				metadata: output.metadata ?? {},
			};
		case "error":
			return {
				output_type: "error",
				ename: output.ename,
				evalue: output.evalue,
				traceback: output.traceback,
			};
	}
}

function parseCheckCases(raw: unknown): LabCheckCase[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: LabCheckCase[] = [];
	for (const entry of raw) {
		const rec = asRecord(entry);
		if (!rec || typeof rec.name !== "string" || typeof rec.passed !== "boolean") continue;
		out.push({
			name: rec.name,
			passed: rec.passed,
			...(typeof rec.message === "string" && rec.message.trim() ? { message: rec.message } : {}),
			...(typeof rec.line === "number" && Number.isFinite(rec.line) ? { line: rec.line } : {}),
		});
	}
	return out.length > 0 ? out : undefined;
}

function parseCheckResult(raw: unknown): LabCheckResult | undefined {
	const rec = asRecord(raw);
	if (!rec || typeof rec.passed !== "boolean" || typeof rec.summary !== "string") return undefined;
	const cases = parseCheckCases(rec.cases);
	const status: "passed" | "failed" =
		rec.status === "passed" || rec.status === "failed"
			? rec.status
			: rec.passed
				? "passed"
				: "failed";
	return {
		passed: rec.passed,
		checkPassed: typeof rec.checkPassed === "boolean" ? rec.checkPassed : rec.passed,
		status,
		summary: rec.summary,
		...(typeof rec.passedCount === "number" ? { passedCount: rec.passedCount } : {}),
		...(typeof rec.totalCount === "number" ? { totalCount: rec.totalCount } : {}),
		...(cases ? { cases } : {}),
		...(typeof rec.ranAt === "string" ? { ranAt: rec.ranAt } : {}),
	};
}

function parsePrediction(raw: unknown): LabPredictionState | undefined {
	const rec = asRecord(raw);
	if (!rec || typeof rec.prompt !== "string") return undefined;
	return {
		prompt: rec.prompt,
		...(typeof rec.answer === "string" ? { answer: rec.answer } : {}),
		...(typeof rec.submittedAt === "string" ? { submittedAt: rec.submittedAt } : {}),
		...(typeof rec.revealed === "boolean" ? { revealed: rec.revealed } : {}),
	};
}

function parseRole(rawRole: unknown, cellType: "code" | "markdown"): LabCellRole {
	if (cellType === "markdown") return "markdown";
	if (rawRole === "check" || rawRole === "predict" || rawRole === "code") return rawRole;
	return "code";
}

function parseAuthor(rawAuthor: unknown): LabCellAuthor {
	return rawAuthor === "mentor" ? "mentor" : "learner";
}

function normalizeCellId(rawId: unknown, index: number, usedIds: Set<string>): string {
	const base = typeof rawId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(rawId) ? rawId : `cell_${index + 1}`;
	let candidate = base;
	let suffix = 2;
	while (usedIds.has(candidate)) {
		candidate = `${base}_${suffix++}`;
	}
	usedIds.add(candidate);
	return candidate;
}

export function createLabCellId(): string {
	const rand = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
		: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	return `cell_${rand}`;
}

export function parseIpynb(rawJson: string): LabNotebook {
	const parsed = JSON.parse(rawJson) as unknown;
	const root = asRecord(parsed);
	if (!root) throw new Error("Invalid .ipynb JSON: expected an object at root.");

	const rawMeta = asRecord(root.metadata) ?? {};
	const twigMeta = asRecord(rawMeta.twig) ?? {};
	const language: LabLanguage = twigMeta.language === "python" ? "python" : "python";
	const { twig: _twigMeta, ...restNotebookMeta } = rawMeta;

	const rawCells = Array.isArray(root.cells) ? root.cells : [];
	const usedIds = new Set<string>();
	const cells: LabCell[] = [];

	rawCells.forEach((entry, index) => {
		const cellRec = asRecord(entry);
		if (!cellRec) return;
		const cellType: "code" | "markdown" = cellRec.cell_type === "markdown" ? "markdown" : "code";
		// Treat raw cells gracefully as markdown so nothing drops silently.
		const id = normalizeCellId(cellRec.id, index, usedIds);
		const cellMeta = asRecord(cellRec.metadata) ?? {};
		const cellTwig = asRecord(cellMeta.twig) ?? {};
		const { twig: _cellTwig, ...restCellMeta } = cellMeta;

		const role = parseRole(cellTwig.role, cellType);
		const author = parseAuthor(cellTwig.author);
		const learnerEdited = typeof cellTwig.learnerEdited === "boolean" ? cellTwig.learnerEdited : author === "learner";
		const title = typeof cellTwig.title === "string" && cellTwig.title.trim() ? cellTwig.title : undefined;
		const durationMs = typeof cellTwig.durationMs === "number" && Number.isFinite(cellTwig.durationMs)
			? cellTwig.durationMs
			: undefined;
		const checkResult = parseCheckResult(cellTwig.checkResult);
		const prediction = role === "predict" ? parsePrediction(cellTwig.prediction) : undefined;
		const sourceHashAtRun = typeof cellTwig.sourceHashAtRun === "string" ? cellTwig.sourceHashAtRun : undefined;
		const lastExecutedAt = typeof cellTwig.lastExecutedAt === "string" ? cellTwig.lastExecutedAt : undefined;
		const failedRunCount = typeof cellTwig.failedRunCount === "number" && Number.isFinite(cellTwig.failedRunCount)
			? Math.max(0, Math.floor(cellTwig.failedRunCount))
			: undefined;

		const outputs = cellType === "code" && Array.isArray(cellRec.outputs)
			? cellRec.outputs.map(parseOutput).filter((o): o is LabOutput => o !== null)
			: [];

		cells.push({
			id,
			cellType,
			role,
			author,
			learnerEdited,
			...(title ? { title } : {}),
			source: joinLines(cellRec.source),
			executionCount: cellType === "code" && typeof cellRec.execution_count === "number" ? cellRec.execution_count : null,
			...(durationMs !== undefined ? { durationMs } : {}),
			outputs,
			...(checkResult ? { checkResult } : {}),
			...(prediction ? { prediction } : {}),
			...(sourceHashAtRun ? { sourceHashAtRun } : {}),
			...(lastExecutedAt ? { lastExecutedAt } : {}),
			...(failedRunCount !== undefined ? { failedRunCount } : {}),
			...(Object.keys(restCellMeta).length > 0 ? { extraMetadata: restCellMeta } : {}),
		});
	});

	return {
		nbformat: 4,
		nbformatMinor: 5,
		language,
		cells,
		...(Object.keys(restNotebookMeta).length > 0 ? { extraMetadata: restNotebookMeta } : {}),
	};
}

export function serializeIpynb(notebook: LabNotebook): string {
	const existingMeta = notebook.extraMetadata ?? {};
	const hasKernelSpec = "kernelspec" in existingMeta;
	const hasLanguageInfo = "language_info" in existingMeta;

	const metadata: Record<string, unknown> = {
		...existingMeta,
		...(hasKernelSpec
			? {}
			: {
					kernelspec: {
						display_name: "Python 3",
						language: "python",
						name: "python3",
					},
			  }),
		...(hasLanguageInfo
			? {}
			: {
					language_info: {
						name: "python",
						file_extension: ".py",
						mimetype: "text/x-python",
					},
			  }),
		twig: {
			version: 1,
			language: notebook.language,
		},
	};

	const cells = notebook.cells.map((cell) => {
		const twigCellMeta: Record<string, unknown> = {
			role: cell.role,
			author: cell.author,
			learnerEdited: cell.learnerEdited,
			...(cell.title ? { title: cell.title } : {}),
			...(cell.durationMs !== undefined ? { durationMs: cell.durationMs } : {}),
			...(cell.checkResult ? { checkResult: cell.checkResult } : {}),
			...(cell.prediction ? { prediction: cell.prediction } : {}),
			...(cell.sourceHashAtRun ? { sourceHashAtRun: cell.sourceHashAtRun } : {}),
			...(cell.lastExecutedAt ? { lastExecutedAt: cell.lastExecutedAt } : {}),
			...(cell.failedRunCount !== undefined ? { failedRunCount: cell.failedRunCount } : {}),
		};
		const cellMetadata: Record<string, unknown> = {
			...(cell.extraMetadata ?? {}),
			twig: twigCellMeta,
		};

		if (cell.cellType === "markdown") {
			return {
				id: cell.id,
				cell_type: "markdown",
				metadata: cellMetadata,
				source: splitLines(cell.source),
			};
		}

		return {
			id: cell.id,
			cell_type: "code",
			execution_count: cell.executionCount,
			metadata: cellMetadata,
			outputs: cell.outputs.map(serializeOutput),
			source: splitLines(cell.source),
		};
	});

	return `${JSON.stringify({
		nbformat: 4,
		nbformat_minor: 5,
		metadata,
		cells,
	}, null, "\t")}\n`;
}

export function createEmptyLabNotebook(title: string, language: LabLanguage = "python"): LabNotebook {
	const heading = title.trim() || "Untitled Lab";
	return {
		nbformat: 4,
		nbformatMinor: 5,
		language,
		cells: [
			{
				id: createLabCellId(),
				cellType: "markdown",
				role: "markdown",
				author: "learner",
				learnerEdited: false,
				source: `# ${heading}\n`,
				executionCount: null,
				outputs: [],
			},
			{
				id: createLabCellId(),
				cellType: "code",
				role: "code",
				author: "learner",
				learnerEdited: true,
				source: "",
				executionCount: null,
				outputs: [],
			},
		],
	};
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n... [truncated ${omitted} chars]`;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * Detect whether an executed code/check cell's source changed after its last run,
 * or whether a passing Check cell sits downstream of an edited/more recently run code cell.
 */
export function isCellStale(cell: LabCell, notebook?: LabNotebook): boolean {
	if (cell.cellType !== "code") return false;
	if (cell.sourceHashAtRun && hashCellSource(cell.source) !== cell.sourceHashAtRun) {
		return true;
	}
	if (cell.role === "check" && cell.checkResult?.passed && notebook) {
		const idx = notebook.cells.findIndex((c) => c.id === cell.id);
		const checkRanAt = cell.checkResult.ranAt ?? cell.lastExecutedAt;
		for (let i = 0; i < idx; i++) {
			const prev = notebook.cells[i]!;
			if (prev.cellType !== "code") continue;
			if (prev.sourceHashAtRun && hashCellSource(prev.source) !== prev.sourceHashAtRun) {
				return true;
			}
			if (checkRanAt && prev.lastExecutedAt && prev.lastExecutedAt > checkRanAt) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Roll up structured status for every `role: "check"` milestone cell in a notebook.
 */
export function summarizeLabChecks(notebook: LabNotebook): LabMilestoneSummary {
	const checks: LabCheckCellStatus[] = [];
	let passed = 0;
	let failed = 0;
	let stale = 0;
	let notRun = 0;

	notebook.cells.forEach((cell, idx) => {
		if (cell.role !== "check") return;
		let status: LabCheckStatus;
		if (!cell.checkResult) {
			status = "not_run";
			notRun++;
		} else if (isCellStale(cell, notebook)) {
			status = "stale";
			stale++;
		} else if (cell.checkResult.passed) {
			status = "passed";
			passed++;
		} else {
			status = "failed";
			failed++;
		}
		const failedCases = cell.checkResult?.cases?.filter((c) => !c.passed);
		checks.push({
			cellId: cell.id,
			index: idx + 1,
			...(cell.title ? { title: cell.title } : {}),
			status,
			checkPassed: status === "passed",
			...(cell.checkResult?.passedCount !== undefined ? { passedCount: cell.checkResult.passedCount } : {}),
			...(cell.checkResult?.totalCount !== undefined ? { totalCount: cell.checkResult.totalCount } : {}),
			...(cell.checkResult?.summary ? { summary: cell.checkResult.summary } : {}),
			...(failedCases && failedCases.length > 0 ? { failedCases } : {}),
		});
	});

	return {
		total: checks.length,
		passed,
		failed,
		stale,
		notRun,
		checks,
	};
}

/**
 * Format the notebook into a concise, structured digest for the Lab AI mentor.
 */
export function summarizeNotebookForModel(
	notebook: LabNotebook,
	opts: {
		maxOutputChars?: number;
		cellIds?: readonly string[];
		nudgeLevel?: LabNudgeLevel;
		priorNudgesByCell?: Record<string, number>;
	} = {},
): string {
	const maxOutputChars = opts.maxOutputChars ?? 1600;
	const filter = opts.cellIds && opts.cellIds.length > 0 ? new Set(opts.cellIds) : null;
	const milestones = summarizeLabChecks(notebook);
	const checkStatusById = new Map(milestones.checks.map((c) => [c.cellId, c]));

	const lines: string[] = [
		`Notebook (${notebook.language}, ${notebook.cells.length} cell${notebook.cells.length === 1 ? "" : "s"}):`,
	];

	if (opts.nudgeLevel) {
		lines.push(`Coaching mode: ${opts.nudgeLevel}`);
	}

	if (milestones.total > 0) {
		const counts = [
			`${milestones.passed}/${milestones.total} passed`,
			...(milestones.failed > 0 ? [`${milestones.failed} failed`] : []),
			...(milestones.stale > 0 ? [`${milestones.stale} stale`] : []),
			...(milestones.notRun > 0 ? [`${milestones.notRun} not run`] : []),
		];
		lines.push(`Milestones / Checks: ${counts.join(", ")}`);
		for (const ch of milestones.checks) {
			lines.push(
				`- Cell ${ch.index} [${ch.status.toUpperCase()}]${ch.title ? ` "${ch.title}"` : ""} (checkPassed=${ch.checkPassed})${ch.summary ? ` — ${ch.summary}` : ""}`,
			);
		}
	}

	notebook.cells.forEach((cell, idx) => {
		if (filter && !filter.has(cell.id)) return;
		const execLabel = cell.cellType === "code" ? `[${cell.executionCount ?? " "}]` : "[md]";
		const stale = isCellStale(cell, notebook);
		const failing = isCellFailing(cell);
		const flags = [
			`id=${cell.id}`,
			`role=${cell.role}`,
			`author=${cell.author}`,
			...(cell.author === "mentor" ? [`learnerEdited=${cell.learnerEdited}`] : []),
			...(stale ? ["stale=true"] : []),
			...(cell.durationMs !== undefined ? [`${cell.durationMs}ms`] : []),
		];
		if (failing && opts.nudgeLevel) {
			const failedRuns = cell.failedRunCount ?? 1;
			const priorNudges = opts.priorNudgesByCell?.[cell.id] ?? 0;
			const stage = computeCellCoachingStage({
				nudgeLevel: opts.nudgeLevel,
				failedRunCount: failedRuns,
				priorMentorNudges: priorNudges,
			});
			flags.push(`failedRuns=${failedRuns}`, `coaching=${stage}`);
		}

		lines.push(`\n--- Cell ${idx + 1} ${execLabel} (${flags.join(", ")}) ---`);
		if (cell.title) lines.push(`Title: ${cell.title}`);
		if (cell.prediction) {
			lines.push(`Prediction prompt: ${cell.prediction.prompt}`);
			if (cell.prediction.answer !== undefined) {
				lines.push(`Learner prediction: ${cell.prediction.answer}`);
			} else {
				lines.push(`Learner prediction: <not yet submitted>`);
			}
		}
		lines.push(cell.cellType === "markdown" ? cell.source : `\`\`\`${notebook.language}\n${cell.source}\n\`\`\``);

		if (cell.role === "check") {
			const cs = checkStatusById.get(cell.id);
			const statusLabel = (cs?.status ?? (cell.checkResult ? (cell.checkResult.passed ? "passed" : "failed") : "not_run")).toUpperCase();
			if (cell.checkResult) {
				const counts =
					cell.checkResult.totalCount !== undefined
						? ` (${cell.checkResult.passedCount ?? 0}/${cell.checkResult.totalCount})`
						: "";
				lines.push(`Check status: ${statusLabel} (checkPassed=${cs?.checkPassed ?? cell.checkResult.passed})${counts} — ${cell.checkResult.summary}`);
				if (cell.checkResult.cases && cell.checkResult.cases.length > 0) {
					for (const c of cell.checkResult.cases) {
						lines.push(
							`  * [${c.passed ? "PASS" : "FAIL"}] ${c.name}${c.line ? ` (line ${c.line})` : ""}${c.message ? `: ${c.message}` : ""}`,
						);
					}
				}
			} else {
				lines.push(`Check status: NOT_RUN (checkPassed=false)`);
			}
		}

		for (const out of cell.outputs) {
			if (out.outputType === "stream") {
				const clean = truncateText(stripAnsi(out.text.trimEnd()), maxOutputChars);
				if (clean) lines.push(`${out.name}:\n${clean}`);
			} else if (out.outputType === "execute_result" || out.outputType === "display_data") {
				const mimeKeys = Object.keys(out.data);
				if (out.data["image/png"]) lines.push(`[image/png output attached/rendered]`);
				if (out.data["image/svg+xml"]) lines.push(`[image/svg+xml output rendered]`);
				if (out.data["text/html"] && !out.data["text/plain"]) {
					lines.push(`[HTML output (${out.data["text/html"].length} chars)]`);
				}
				const plain = out.data["text/plain"];
				if (plain) {
					lines.push(`result:\n${truncateText(stripAnsi(plain.trimEnd()), maxOutputChars)}`);
				} else if (mimeKeys.length > 0 && !out.data["image/png"] && !out.data["image/svg+xml"]) {
					lines.push(`[output mime types: ${mimeKeys.join(", ")}]`);
				}
			} else if (out.outputType === "error") {
				const tb = out.traceback.length > 0
					? stripAnsi(out.traceback.join("\n"))
					: `${out.ename}: ${out.evalue}`;
				lines.push(`error:\n${truncateText(tb.trimEnd(), maxOutputChars)}`);
			}
		}
	});

	if (notebook.cells.length === 0) lines.push("(Notebook has no cells.)");
	return lines.join("\n");
}

export function slugifyLabFolderName(title: string): string {
	const ascii = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	const slug = ascii
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug || "lab";
}

/**
 * Strict sanitizer for Jupyter `text/html` cell outputs (such as pandas
 * DataFrame HTML tables). Strips scripts, active embed tags, inline event
 * handlers, and dangerous URLs.
 */
export function sanitizeLabHtmlOutput(html: string): string {
	return html
		.replace(/<\s*(script|iframe|object|embed|style|link|meta|base|form)\b[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi, "")
		.replace(/<\s*\/?\s*(script|iframe|object|embed|style|link|meta|base|form)\b[^>]*>/gi, "")
		.replace(/\s+on[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/\s+(href|src|xlink:href|action|formaction)\s*=\s*(?:"\s*(?:javascript|vbscript|data:text\/html)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html)[^']*'|[^\s>]*javascript:[^\s>]*)/gi, "");
}
