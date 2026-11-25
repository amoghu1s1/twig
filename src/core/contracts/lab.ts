/**
 * Lab session contracts — Jupyter-inspired guided notebook workspace.
 * Pure browser-safe types and constants (zero node:* imports).
 */

export type LabLanguage = "python";

/** How aggressively the Lab mentor scopes feedback vs direct solution code. */
export type LabNudgeLevel = "nudge" | "balanced" | "direct";

export interface LabSessionMeta {
	/** Real directory on disk bound to this Lab session. */
	workspaceDir: string;
	/** Notebook filename relative to workspaceDir (typically "notebook.ipynb"). */
	notebookFile: string;
	/** Primary notebook kernel language. */
	language: LabLanguage;
	/** Selected local interpreter/runtime executable path, if chosen. */
	interpreterPath?: string;
	/** Active coaching nudge level for this Lab session (defaults to "nudge"). */
	nudgeLevel?: LabNudgeLevel;
}

export type LabCellRole = "code" | "markdown" | "check" | "predict";
export type LabCellAuthor = "learner" | "mentor";

export interface LabCheckCase {
	name: string;
	passed: boolean;
	message?: string;
	line?: number;
}

export type LabCheckStatus = "passed" | "failed" | "stale" | "not_run";

export interface LabCheckResult {
	passed: boolean;
	/** Explicit alias for passed so tools & UI expose consistent pass/fail status. */
	checkPassed?: boolean;
	status?: "passed" | "failed";
	summary: string;
	passedCount?: number;
	totalCount?: number;
	cases?: LabCheckCase[];
	ranAt?: string;
}

export interface LabCheckCellStatus {
	cellId: string;
	index: number;
	title?: string;
	status: LabCheckStatus;
	checkPassed: boolean;
	passedCount?: number;
	totalCount?: number;
	summary?: string;
	failedCases?: LabCheckCase[];
}

export interface LabMilestoneSummary {
	total: number;
	passed: number;
	failed: number;
	stale: number;
	notRun: number;
	checks: LabCheckCellStatus[];
}

export interface LabPredictionState {
	prompt: string;
	answer?: string;
	submittedAt?: string;
	revealed?: boolean;
}

export type LabOutput =
	| {
			outputType: "stream";
			name: "stdout" | "stderr";
			text: string;
	  }
	| {
			outputType: "display_data";
			data: Record<string, string>;
			metadata?: Record<string, unknown>;
	  }
	| {
			outputType: "execute_result";
			executionCount: number | null;
			data: Record<string, string>;
			metadata?: Record<string, unknown>;
	  }
	| {
			outputType: "error";
			ename: string;
			evalue: string;
			traceback: string[];
	  };

export interface LabCell {
	id: string;
	cellType: "code" | "markdown";
	role: LabCellRole;
	author: LabCellAuthor;
	/** True once the learner modifies a cell, blocking silent mentor overwrites. */
	learnerEdited: boolean;
	title?: string;
	source: string;
	executionCount: number | null;
	durationMs?: number;
	outputs: LabOutput[];
	checkResult?: LabCheckResult;
	prediction?: LabPredictionState;
	/** Source fingerprint captured at the most recent execution (for stale detection). */
	sourceHashAtRun?: string;
	/** ISO timestamp of the most recent execution. */
	lastExecutedAt?: string;
	/** Consecutive failing runs since last clean pass (drives nudge escalation). */
	failedRunCount?: number;
	/** Preserved unknown Jupyter cell metadata fields (not owned by Twig). */
	extraMetadata?: Record<string, unknown>;
}

export interface LabNotebook {
	nbformat: 4;
	nbformatMinor: 5;
	language: LabLanguage;
	cells: LabCell[];
	/** Preserved unknown Jupyter notebook metadata fields (not owned by Twig). */
	extraMetadata?: Record<string, unknown>;
}

export type KernelStatus = "idle" | "busy" | "starting" | "dead" | "error";

export interface KernelVariable {
	name: string;
	typeName: string;
	summary: string;
	shape?: number[];
	dtype?: string;
	device?: string;
	sizeHint?: string;
}

export interface PythonEnvInfo {
	path: string;
	label: string;
	version: string;
	kind: "workspace-venv" | "venv" | "conda" | "uv" | "pyenv" | "system" | "custom";
	packages: string[];
}

export interface LabWorkspaceFile {
	path: string;
	name: string;
	kind: "file" | "dir";
	sizeBytes?: number;
	editable?: boolean;
}

export type LabStreamEvent =
	| { type: "status"; status: KernelStatus }
	| { type: "stream"; cellId: string; name: "stdout" | "stderr"; text: string }
	| { type: "output"; cellId: string; output: LabOutput }
	| { type: "check_result"; cellId: string; result: LabCheckResult }
	| {
			type: "done";
			cellId: string;
			executionCount: number | null;
			durationMs: number;
			status: "ok" | "error" | "interrupted";
			variables: KernelVariable[];
			revision?: string;
			reloadedModules?: string[];
			sourceHashAtRun?: string;
			lastExecutedAt?: string;
			failedRunCount?: number;
	  }
	| { type: "kernel_error"; message: string };

export interface LabNotebookSnapshot {
	meta: LabSessionMeta;
	notebook: LabNotebook;
	revision: string;
	kernelStatus: KernelStatus;
	variables: KernelVariable[];
}
