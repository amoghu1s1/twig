/**
 * THE LAB TOOLS: the Lab mentor agent's registry — `read_notebook`,
 * `inspect_variables`, `insert_cell`, `update_mentor_cell`,
 * `delete_mentor_cell`, plus workspace-scoped `read` / `ls` / `find` / `grep`.
 *
 * Ownership enforcement lives here in code (never doctrine alone):
 *   - `insert_cell` always stamps `author: "mentor", learnerEdited: false`.
 *   - `update_mentor_cell` and `delete_mentor_cell` HARD-REFUSE any cell where
 *     `author !== "mentor"` or `learnerEdited === true`.
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveTargetId } from "../../core/chains.ts";
import type { GraphNode } from "../../core/contracts/graph.ts";
import type { KernelVariable, LabCell, LabCellRole, LabNotebook, LabNudgeLevel } from "../../core/contracts/lab.ts";
import { createLabCellId, summarizeLabChecks, summarizeNotebookForModel } from "../../core/lab-ipynb.ts";
import { countPriorMentorNudges, isCellFailing, normalizeLabNudgeLevel } from "../../core/lab-nudge.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { invalidInputResult } from "../tool-execute.ts";
import { proberGraphTools, type GraphToolContext } from "./graph.ts";
import { healToolRecord, healEncodedArguments } from "./heal.ts";
import { projectFsTools } from "./scoped-fs.ts";

export interface LabToolContext {
	chatId: string;
	readNotebook: () => Promise<{ notebook: LabNotebook; revision: string }>;
	writeNotebook: (notebook: LabNotebook, expectedRevision?: string) => Promise<{ revision: string }>;
	inspectVariables: () => Promise<KernelVariable[]>;
	getWorkspaceRoot: () => Promise<string | null>;
	emitLabChanged: (payload: { revision?: string; focusCellId?: string }) => void;
	supportsImages?: boolean;
	/** Active session nudge level ("nudge" | "balanced" | "direct"). */
	getNudgeLevel?: () => LabNudgeLevel;
	/** Saved conversation messages for per-cell prior-nudge counting. */
	getMessages?: () => readonly LhMessage[];
	/** Whole-graph propositions for validating lab_summary gap targets (read-only). */
	graphNodes?: () => ReadonlyArray<Pick<GraphNode, "id" | "name" | "statement">>;
	/** Optional read-only knowledge graph readers (list_sessions / list_propositions). */
	graph?: GraphToolContext;
}

const MAX_NOTEBOOK_IMAGES = 4;

// ─── read_notebook ───────────────────────────────────────────────────────────

export const readNotebookInputObject = Type.Object({
	includeImages: Type.Optional(
		Type.Boolean({
			description: "Attach up to 4 recent PNG plot/image outputs from notebook cells so vision models can inspect rendered plots.",
		}),
	),
	cellIds: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional list of cell ids to focus on; omit to read the whole notebook.",
		}),
	),
});

export function readNotebookTool(ctx: LabToolContext): AgentTool<typeof readNotebookInputObject> {
	return {
		name: "read_notebook",
		label: "read_notebook",
		description:
			"Read the current Lab notebook (.ipynb): all cell indices, ids, roles, authorship, source code, execution counts, stdout/stderr, tracebacks, check results, and prediction answers.",
		parameters: readNotebookInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => healEncodedArguments(args ?? {}, readNotebookInputObject) as never,
		execute: async (_id, input) => {
			const { notebook, revision } = await ctx.readNotebook();
			const nudgeLevel = normalizeLabNudgeLevel(ctx.getNudgeLevel?.());
			const milestones = summarizeLabChecks(notebook);
			const messages = ctx.getMessages?.() ?? [];
			const priorNudgesByCell: Record<string, number> = {};
			if (messages.length > 0) {
				for (const cell of notebook.cells) {
					if (isCellFailing(cell)) {
						priorNudgesByCell[cell.id] = countPriorMentorNudges(messages, cell.id);
					}
				}
			}
			const summary = summarizeNotebookForModel(notebook, {
				cellIds: input.cellIds,
				nudgeLevel,
				priorNudgesByCell,
			});
			const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
			const notes: string[] = [];

			if (input.includeImages) {
				const filter = input.cellIds?.length ? new Set(input.cellIds) : null;
				const collected: Array<{ data: string; mimeType: string }> = [];
				for (const cell of notebook.cells) {
					if (filter && !filter.has(cell.id)) continue;
					for (const out of cell.outputs) {
						if (out.outputType !== "display_data" && out.outputType !== "execute_result") continue;
						const png = out.data["image/png"];
						if (typeof png === "string" && png.length > 0) {
							collected.push({ data: png, mimeType: "image/png" });
						}
					}
				}
				const recent = collected.slice(-MAX_NOTEBOOK_IMAGES);
				if (recent.length > 0) {
					if (ctx.supportsImages === false) {
						notes.push(`[${recent.length} PNG plot output(s) present, omitted because the active model does not accept image input.]`);
					} else {
						for (const img of recent) images.push({ type: "image", data: img.data, mimeType: img.mimeType });
					}
				}
			}

			const fullText = notes.length > 0 ? `${summary}\n\n${notes.join("\n")}` : summary;
			return {
				content: [{ type: "text", text: fullText }, ...images],
				details: {
					cellCount: notebook.cells.length,
					revision,
					attachedImages: images.length,
					nudgeLevel,
					milestones,
				},
			};
		},
	};
}

// ─── inspect_variables ───────────────────────────────────────────────────────

export const inspectVariablesInputObject = Type.Object({});

export function inspectVariablesTool(ctx: LabToolContext): AgentTool<typeof inspectVariablesInputObject> {
	return {
		name: "inspect_variables",
		label: "inspect_variables",
		description:
			"Inspect variables currently alive in the Lab Python kernel (types, shapes, dtypes, devices, parameter counts, and short value previews).",
		parameters: inspectVariablesInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => healEncodedArguments(args ?? {}, inspectVariablesInputObject) as never,
		execute: async () => {
			const vars = await ctx.inspectVariables();
			if (vars.length === 0) {
				return {
					content: [{ type: "text", text: "No live variables in the kernel (either the kernel has not run any code yet, or no user variables are defined)." }],
					details: { variables: [] },
				};
			}
			const lines = vars.map((v) => {
				const parts = [`${v.name}: ${v.typeName}`];
				if (v.shape) parts.push(`shape=(${v.shape.join(", ")})`);
				if (v.dtype) parts.push(`dtype=${v.dtype}`);
				if (v.device) parts.push(`device=${v.device}`);
				if (v.sizeHint) parts.push(v.sizeHint);
				if (v.summary) parts.push(`= ${v.summary}`);
				return `- ${parts.join(" · ")}`;
			});
			return {
				content: [{ type: "text", text: `Live kernel variables (${vars.length}):\n${lines.join("\n")}` }],
				details: { variables: vars },
			};
		},
	};
}

// ─── insert_cell ─────────────────────────────────────────────────────────────

export const insertCellInputObject = Type.Object({
	cellType: Type.Union([Type.Literal("code"), Type.Literal("markdown")], {
		description: 'REQUIRED — "code" or "markdown".',
	}),
	role: Type.Optional(
		Type.Union([Type.Literal("code"), Type.Literal("markdown"), Type.Literal("check"), Type.Literal("predict")], {
			description: 'Cell role: "code" (starter/experiment), "markdown" (framing/notes), "check" (assertions/tests), or "predict" (learner predicts output before running). Defaults to cellType.',
		}),
	),
	source: Type.String({
		description: "REQUIRED — cell contents (Python code for code/check/predict cells, Markdown/KaTeX for markdown cells).",
	}),
	title: Type.Optional(Type.String({ description: "Optional short label shown on the cell header and transcript card." })),
	afterCellId: Type.Optional(Type.String({ description: "Insert immediately after this cell id; omit to append at the end of the notebook." })),
	predictionPrompt: Type.Optional(Type.String({ description: 'Required when role is "predict": short prompt asking the learner to predict the output or shape before running.' })),
});

export function insertCellTool(ctx: LabToolContext): AgentTool<typeof insertCellInputObject> {
	return {
		name: "insert_cell",
		label: "insert_cell",
		description:
			"Insert a new cell into the Lab notebook (authored as mentor). Use for Markdown framing, starter # TODO code cells, runnable experiment cells, Check assertion cells, or Predict-before-Run cells.",
		parameters: insertCellInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => healEncodedArguments(args, insertCellInputObject) as never,
		execute: async (_id, input) => {
			const role: LabCellRole = input.cellType === "markdown" ? "markdown" : (input.role ?? "code");
			if (input.cellType === "markdown" && input.role && input.role !== "markdown") {
				return invalidInputResult("insert_cell", [`markdown cells must use role "markdown", not "${input.role}"`]);
			}
			if (role === "predict" && (!input.predictionPrompt || !input.predictionPrompt.trim())) {
				return invalidInputResult("insert_cell", ['role "predict" requires a non-empty predictionPrompt']);
			}

			const { notebook, revision } = await ctx.readNotebook();
			let insertIndex = notebook.cells.length;
			if (input.afterCellId) {
				const found = notebook.cells.findIndex((c) => c.id === input.afterCellId);
				if (found === -1) {
					return invalidInputResult("insert_cell", [`afterCellId "${input.afterCellId}" does not match any cell in the notebook`]);
				}
				insertIndex = found + 1;
			}

			const cellId = createLabCellId();
			const title = input.title?.trim() || undefined;
			const cell: LabCell = {
				id: cellId,
				cellType: input.cellType,
				role,
				author: "mentor",
				learnerEdited: false,
				...(title ? { title } : {}),
				source: input.source,
				executionCount: null,
				outputs: [],
				...(role === "predict" ? { prediction: { prompt: input.predictionPrompt!.trim() } } : {}),
			};

			const nextCells = [...notebook.cells];
			nextCells.splice(insertIndex, 0, cell);
			const nextNotebook: LabNotebook = { ...notebook, cells: nextCells };
			const saved = await ctx.writeNotebook(nextNotebook, revision);
			ctx.emitLabChanged({ revision: saved.revision, focusCellId: cellId });

			const details = {
				cellId,
				index: insertIndex + 1,
				cellType: cell.cellType,
				role: cell.role,
				...(title ? { title } : {}),
			};
			return {
				content: [{ type: "text", text: `Inserted ${role} cell ${cellId} at position ${insertIndex + 1}.` }],
				details,
			};
		},
	};
}

// ─── update_mentor_cell ──────────────────────────────────────────────────────

export const updateMentorCellInputObject = Type.Object({
	cellId: Type.String({ minLength: 1, description: "REQUIRED — id of an unedited mentor-authored cell." }),
	source: Type.String({ description: "REQUIRED — replacement cell source." }),
	title: Type.Optional(Type.String({ description: "Optional updated title." })),
	predictionPrompt: Type.Optional(Type.String({ description: "Optional updated prediction prompt for predict cells." })),
});

export function updateMentorCellTool(ctx: LabToolContext): AgentTool<typeof updateMentorCellInputObject> {
	return {
		name: "update_mentor_cell",
		label: "update_mentor_cell",
		description:
			"Update an existing cell ONLY if it was authored by the mentor and has NOT been edited by the learner. Learner-owned or learner-edited cells are strictly protected and refused.",
		parameters: updateMentorCellInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => healEncodedArguments(args, updateMentorCellInputObject) as never,
		execute: async (_id, input) => {
			const { notebook, revision } = await ctx.readNotebook();
			const idx = notebook.cells.findIndex((c) => c.id === input.cellId);
			if (idx === -1) {
				return invalidInputResult("update_mentor_cell", [`cell "${input.cellId}" does not exist`]);
			}
			const existing = notebook.cells[idx]!;
			if (existing.author !== "mentor" || existing.learnerEdited) {
				return invalidInputResult("update_mentor_cell", [
					`cell "${input.cellId}" is owned or edited by the learner and cannot be overwritten — explain in chat or insert a separate cell instead`,
				]);
			}
			if (existing.role === "predict" && input.predictionPrompt !== undefined && !input.predictionPrompt.trim()) {
				return invalidInputResult("update_mentor_cell", ["predictionPrompt cannot be blank on a predict cell"]);
			}

			const updated: LabCell = {
				...existing,
				source: input.source,
				...(input.title !== undefined ? { title: input.title.trim() || undefined } : {}),
				...(existing.role === "predict" && input.predictionPrompt !== undefined
					? { prediction: { ...existing.prediction, prompt: input.predictionPrompt.trim() } }
					: {}),
			};
			const nextCells = [...notebook.cells];
			nextCells[idx] = updated;
			const saved = await ctx.writeNotebook({ ...notebook, cells: nextCells }, revision);
			ctx.emitLabChanged({ revision: saved.revision, focusCellId: updated.id });

			return {
				content: [{ type: "text", text: `Updated mentor cell ${updated.id} at position ${idx + 1}.` }],
				details: {
					cellId: updated.id,
					index: idx + 1,
					cellType: updated.cellType,
					role: updated.role,
					...(updated.title ? { title: updated.title } : {}),
				},
			};
		},
	};
}

// ─── delete_mentor_cell ──────────────────────────────────────────────────────

export const deleteMentorCellInputObject = Type.Object({
	cellId: Type.String({ minLength: 1, description: "REQUIRED — id of an unedited mentor-authored cell to remove." }),
});

export function deleteMentorCellTool(ctx: LabToolContext): AgentTool<typeof deleteMentorCellInputObject> {
	return {
		name: "delete_mentor_cell",
		label: "delete_mentor_cell",
		description:
			"Delete an unedited mentor-authored cell from the notebook. Learner-owned or learner-edited cells are protected and refused.",
		parameters: deleteMentorCellInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => healEncodedArguments(args, deleteMentorCellInputObject) as never,
		execute: async (_id, input) => {
			const { notebook, revision } = await ctx.readNotebook();
			const idx = notebook.cells.findIndex((c) => c.id === input.cellId);
			if (idx === -1) {
				return invalidInputResult("delete_mentor_cell", [`cell "${input.cellId}" does not exist`]);
			}
			const existing = notebook.cells[idx]!;
			if (existing.author !== "mentor" || existing.learnerEdited) {
				return invalidInputResult("delete_mentor_cell", [
					`cell "${input.cellId}" is owned or edited by the learner and cannot be deleted`,
				]);
			}
			const nextCells = notebook.cells.filter((c) => c.id !== input.cellId);
			const saved = await ctx.writeNotebook({ ...notebook, cells: nextCells }, revision);
			ctx.emitLabChanged({ revision: saved.revision });
			return {
				content: [{ type: "text", text: `Deleted mentor cell ${input.cellId}.` }],
				details: { cellId: input.cellId, index: idx + 1, role: existing.role },
			};
		},
	};
}

// ─── lab_summary ─────────────────────────────────────────────────────────────

export const labGapItemObject = Type.Object({
	area: Type.String({ minLength: 1, description: "Short topic/skill label for the gap." }),
	note: Type.String({ minLength: 1, description: "Concrete observation of what broke or stayed shaky in this Lab." }),
	targets: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Optional matching graph proposition ids (verified from list_propositions or graph context); omit/empty if none match.",
		}),
	),
});

export const labSummaryInputObject = Type.Object({
	summary: Type.String({ minLength: 1, description: "REQUIRED — concise wrap-up of what was built and verified." }),
	milestonesCompleted: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "List of completed milestone / Check cell titles or accomplishments.",
		}),
	),
	gaps: Type.Array(labGapItemObject, {
		description: "Concepts or debugging patterns that still need review or deliberate practice (empty array if none).",
	}),
});

export function labSummaryTool(ctx: LabToolContext): AgentTool<typeof labSummaryInputObject> {
	return {
		name: "lab_summary",
		label: "lab_summary",
		description:
			"Emit a structured Lab Summary & Gaps card in the transcript with completed milestones and follow-up Teaching/Practice links (read-only on the Knowledge Graph; never modifies graph nodes).",
		parameters: labSummaryInputObject,
		executionMode: "sequential",
		prepareArguments: (args: unknown) => healEncodedArguments(args ?? {}, labSummaryInputObject) as never,
		execute: async (_id, input) => {
			const summary = input.summary.trim();
			if (!summary) {
				return invalidInputResult("lab_summary", ["summary must be a non-empty string"]);
			}

			const allNodes = ctx.graphNodes?.() ?? [];
			const gaps: Array<{ area: string; note: string; targets: string[] }> = [];
			const errors: string[] = [];

			for (const g of input.gaps) {
				const area = g.area.trim();
				const note = g.note.trim();
				if (!area || !note) {
					errors.push("every gap entry requires non-empty area and note");
					continue;
				}
				const resolvedTargets: string[] = [];
				for (const rawTarget of g.targets ?? []) {
					if (allNodes.length === 0) {
						errors.push(`unknown graph target "${rawTarget}" (no matching propositions in Knowledge Graph)`);
						continue;
					}
					const id = resolveTargetId(rawTarget, allNodes);
					if (!id) {
						errors.push(`unknown graph target "${rawTarget}" — pass an exact proposition id from list_propositions or omit`);
					} else if (!resolvedTargets.includes(id)) {
						resolvedTargets.push(id);
					}
				}
				gaps.push({ area, note, targets: resolvedTargets });
			}

			if (errors.length > 0) {
				return invalidInputResult("lab_summary", errors);
			}

			const milestonesCompleted = (input.milestonesCompleted ?? [])
				.map((m) => m.trim())
				.filter(Boolean);

			const details = {
				summary,
				milestonesCompleted,
				gaps,
			};

			const lines = [
				`Lab summary recorded: ${summary}`,
				...(milestonesCompleted.length > 0 ? [`Completed milestones (${milestonesCompleted.length}): ${milestonesCompleted.join("; ")}`] : []),
				...(gaps.length > 0 ? [`Follow-up gaps (${gaps.length}): ${gaps.map((g) => g.area).join("; ")}`] : ["No open gaps recorded."]),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details,
			};
		},
	};
}

// ─── the registry ────────────────────────────────────────────────────────────

export function labTools(ctx: LabToolContext): Record<string, AgentTool<any>> {
	return healToolRecord({
		read_notebook: readNotebookTool(ctx),
		inspect_variables: inspectVariablesTool(ctx),
		insert_cell: insertCellTool(ctx),
		update_mentor_cell: updateMentorCellTool(ctx),
		delete_mentor_cell: deleteMentorCellTool(ctx),
		lab_summary: labSummaryTool(ctx),
		...projectFsTools(ctx.getWorkspaceRoot),
		...(ctx.graph ? proberGraphTools(ctx.graph) : {}),
	});
}
