import type {
	KernelStatus,
	KernelVariable,
	LabCellRole,
	LabLanguage,
	LabStreamEvent,
} from "../../core/contracts/lab.ts";

export interface KernelExecuteRequest {
	cellId: string;
	code: string;
	role: LabCellRole;
}

export interface KernelExecutionSummary {
	executionCount: number | null;
	durationMs: number;
	status: "ok" | "error" | "interrupted";
	variables: KernelVariable[];
	reloadedModules?: string[];
}

/**
 * Language-agnostic local execution kernel contract.
 * v1 ships PythonLabKernel; JS/TS, C++, Rust, and SQL kernels implement this
 * same interface in v2 without touching the notebook UI or mentor tools.
 */
export interface LabKernel {
	readonly language: LabLanguage;
	readonly interpreterPath: string;
	readonly cwd: string;
	status(): KernelStatus;
	start(): Promise<void>;
	execute(
		req: KernelExecuteRequest,
		onEvent: (event: LabStreamEvent) => void,
	): Promise<KernelExecutionSummary>;
	interrupt(): Promise<void>;
	restart(): Promise<void>;
	inspectVars(): Promise<KernelVariable[]>;
	shutdown(): Promise<void>;
}
