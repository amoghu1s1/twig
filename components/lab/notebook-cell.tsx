"use client";

import { useState } from "react";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	CheckCircle2Icon,
	ChevronDownIcon,
	Code2Icon,
	EyeIcon,
	FileCode2Icon,
	LockIcon,
	MessageSquareIcon,
	PencilIcon,
	PlayIcon,
	PlusIcon,
	RotateCwIcon,
	SquareIcon,
	Trash2Icon,
	XCircleIcon,
} from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { BrailleSpinner } from "@/components/braille-spinner";
import { isCellStale, type LabCell, type LabLanguage, type LabNotebook } from "@/src/core";
import { CellOutputs } from "./cell-outputs";
import { CodeMirrorEditor } from "./code-mirror-editor";

export type LabAskPreset = "default" | "hint" | "check" | "explain" | "fix";

export interface NotebookCellProps {
	cell: LabCell;
	notebook?: LabNotebook;
	index: number;
	totalCells: number;
	language: LabLanguage;
	running: boolean;
	highlighted?: boolean;
	onChange: (updater: (prev: LabCell) => LabCell) => void;
	onRun: (cellId: string) => void;
	onRunAndAdvance: (cellId: string) => void;
	onInterrupt: () => void;
	onMoveUp: (cellId: string) => void;
	onMoveDown: (cellId: string) => void;
	onInsertBelow: (cellId: string, cellType: "code" | "markdown") => void;
	onDelete: (cellId: string) => void;
	onAskMentor: (
		cell: LabCell,
		index: number,
		opts?: { errorSummary?: string; preset?: LabAskPreset },
	) => void;
	onExtractModule?: (cell: LabCell) => void;
	onOpenImage?: (url: string) => void;
}

export function NotebookCell({
	cell,
	notebook,
	index,
	totalCells,
	language,
	running,
	highlighted = false,
	onChange,
	onRun,
	onRunAndAdvance,
	onInterrupt,
	onMoveUp,
	onMoveDown,
	onInsertBelow,
	onDelete,
	onAskMentor,
	onExtractModule,
	onOpenImage,
}: NotebookCellProps) {
	const [editingMarkdown, setEditingMarkdown] = useState(cell.cellType === "markdown" && cell.source.trim() === "");
	const [predictionDraft, setPredictionDraft] = useState(cell.prediction?.answer ?? "");
	const [presetMenuOpen, setPresetMenuOpen] = useState(false);

	const stale = isCellStale(cell, notebook);

	const predictionLocked =
		cell.role === "predict" &&
		cell.prediction !== undefined &&
		cell.prediction.answer === undefined &&
		!cell.prediction.revealed;

	const isCheck = cell.role === "check";
	const isPredict = cell.role === "predict";

	const submitPrediction = (skipped = false) => {
		const answer = skipped ? "(skipped prediction)" : predictionDraft.trim();
		if (!answer) return;
		onChange((prev) => ({
			...prev,
			prediction: {
				prompt: prev.prediction?.prompt ?? "Predict the output before running.",
				answer,
				submittedAt: new Date().toISOString(),
				revealed: false,
			},
		}));
	};

	const cellBorder = highlighted
		? "border-foreground/50 ring-1 ring-foreground/20"
		: isCheck && cell.checkResult
			? stale
				? "border-warning/45"
				: cell.checkResult.passed
					? "border-success/40"
					: "border-error/50"
			: "border-border/80 focus-within:border-muted-foreground/60";

	if (cell.cellType === "markdown") {
		return (
			<div
				id={`lab-cell-${cell.id}`}
				data-testid={`lab-cell-${cell.id}`}
				data-cell-role="markdown"
				className={`group relative rounded-lg border bg-card/40 transition-colors ${cellBorder}`}
			>
				<div className="flex items-center justify-between gap-2 px-3 pt-2 text-[11px] text-muted-foreground">
					<span className="font-mono uppercase tracking-wider">
						Markdown{cell.author === "mentor" ? " · mentor" : ""}
					</span>
					<div className="flex items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
						<button
							type="button"
							onClick={() => setEditingMarkdown((e) => !e)}
							className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
						>
							{editingMarkdown ? <EyeIcon className="size-3" /> : <PencilIcon className="size-3" />}
							{editingMarkdown ? "Preview" : "Edit"}
						</button>
						<button
							type="button"
							title="Ask mentor about this cell"
							onClick={() => onAskMentor(cell, index)}
							className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
						>
							<MessageSquareIcon className="size-3" />
							Ask
						</button>
						<CellOrderMenu
							index={index}
							totalCells={totalCells}
							onMoveUp={() => onMoveUp(cell.id)}
							onMoveDown={() => onMoveDown(cell.id)}
							onInsertBelow={(kind) => onInsertBelow(cell.id, kind)}
							onDelete={() => onDelete(cell.id)}
						/>
					</div>
				</div>

				{editingMarkdown ? (
					<div className="px-1 pb-2">
						<CodeMirrorEditor
							value={cell.source}
							language="plain"
							placeholder="Write Markdown or $LaTeX$ notes… (Shift+Enter to render)"
							ariaLabel={`Markdown cell ${index + 1}`}
							onChange={(next) =>
								onChange((prev) => ({
									...prev,
									source: next,
									learnerEdited: prev.author === "mentor" ? true : prev.learnerEdited,
								}))
							}
							onRunAndAdvance={() => setEditingMarkdown(false)}
							onRunInPlace={() => setEditingMarkdown(false)}
						/>
					</div>
				) : (
					<div
						onDoubleClick={() => setEditingMarkdown(true)}
						className="cursor-text px-4 py-3 text-sm [&_h1]:mt-0 [&_h1]:font-title [&_h1]:text-2xl [&_h2]:mt-0 [&_h2]:font-title [&_h2]:text-xl [&_p:last-child]:mb-0"
					>
						{cell.source.trim() ? (
							<MessageResponse>{cell.source}</MessageResponse>
						) : (
							<p className="text-xs italic text-muted-foreground">Empty markdown cell — double-click to write</p>
						)}
					</div>
				)}
			</div>
		);
	}

	return (
		<div
			id={`lab-cell-${cell.id}`}
			data-testid={`lab-cell-${cell.id}`}
			data-cell-role={cell.role}
			className={`group relative overflow-hidden rounded-lg border bg-card transition-colors ${cellBorder}`}
		>
			{/* Cell header strip */}
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 bg-background/40 px-3 py-1.5 text-xs">
				<div className="flex items-center gap-2 min-w-0">
					<button
						type="button"
						disabled={predictionLocked}
						onClick={() => (running ? onInterrupt() : onRun(cell.id))}
						title={predictionLocked ? "Submit a prediction first" : running ? "Interrupt execution" : "Run cell (Shift+Enter)"}
						data-testid={`lab-run-${cell.id}`}
						className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded bg-accent/80 text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
					>
						{running ? (
							<SquareIcon className="size-3 text-error" />
						) : predictionLocked ? (
							<LockIcon className="size-3 text-muted-foreground" />
						) : (
							<PlayIcon className="size-3" />
						)}
					</button>

					<span className="font-mono text-[11px] tabular-nums text-muted-foreground">
						[{running ? "*" : (cell.executionCount ?? " ")}]
					</span>

					{running && <BrailleSpinner label="Running cell" />}

					{cell.durationMs !== undefined && !running && (
						<span className="font-mono text-[11px] tabular-nums text-muted-foreground/80">
							{cell.durationMs}ms
						</span>
					)}

					{isCheck && (
						<span
							data-testid={`lab-check-badge-${cell.id}`}
							className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
								cell.checkResult
									? stale
										? "bg-warning/15 text-warning"
										: cell.checkResult.passed
											? "bg-success/15 text-success"
											: "bg-error/15 text-error"
									: "bg-accent text-muted-foreground"
							}`}
						>
							{cell.checkResult ? (
								stale ? (
									<RotateCwIcon className="size-3" />
								) : cell.checkResult.passed ? (
									<CheckCircle2Icon className="size-3" />
								) : (
									<XCircleIcon className="size-3" />
								)
							) : (
								<Code2Icon className="size-3" />
							)}
							{cell.checkResult
								? stale
									? "Stale · re-run check"
									: cell.checkResult.summary
								: "Not run · Check cell"}
						</span>
					)}

					{stale && !isCheck && (
						<span
							data-testid={`lab-stale-${cell.id}`}
							title="Code edited since last run — press Shift+Enter to re-run"
							className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[10px] font-medium text-warning"
						>
							<RotateCwIcon className="size-2.5" />
							Modified
						</span>
					)}

					{isPredict && (
						<span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[11px] text-muted-foreground">
							Predict before run
						</span>
					)}

					{cell.title && (
						<span className="truncate text-xs font-medium text-foreground/90">{cell.title}</span>
					)}
				</div>

				<div className="flex items-center gap-1 text-[11px] text-muted-foreground opacity-80 transition-opacity group-hover:opacity-100">
					{cell.author === "mentor" && (
						<span className="mr-1 rounded bg-background px-1.5 py-0.5 font-mono text-[10px]">
							{cell.learnerEdited ? "mentor · edited" : "mentor"}
						</span>
					)}
					{onExtractModule && cell.source.trim().length > 0 && !isCheck && (
						<button
							type="button"
							onClick={() => onExtractModule(cell)}
							title="Extract cell to a .py module in Workspace Files"
							data-testid={`lab-extract-${cell.id}`}
							className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
						>
							<FileCode2Icon className="size-3" />
							Extract .py
						</button>
					)}
					<div className="relative flex items-center">
						<button
							type="button"
							onClick={() => onAskMentor(cell, index)}
							className="inline-flex cursor-pointer items-center gap-1 rounded-l px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
						>
							<MessageSquareIcon className="size-3" />
							Ask mentor
						</button>
						<button
							type="button"
							aria-label="Ask mentor presets"
							aria-expanded={presetMenuOpen}
							data-testid={`lab-ask-presets-${cell.id}`}
							onClick={() => setPresetMenuOpen((o) => !o)}
							className="inline-flex cursor-pointer items-center rounded-r px-1 py-0.5 hover:bg-accent hover:text-foreground"
						>
							<ChevronDownIcon className="size-3" />
						</button>
						{presetMenuOpen && (
							<div
								data-testid={`lab-ask-menu-${cell.id}`}
								className="absolute right-0 top-full z-30 mt-1 w-40 rounded-md border border-border bg-card p-1 shadow-lg text-[11px]"
							>
								{(
									[
										["hint", "Hint only"],
										["check", "Check my work"],
										["explain", "Explain cell"],
										["fix", "Show fix"],
									] as const
								).map(([preset, label]) => (
									<button
										key={preset}
										type="button"
										onClick={() => {
											setPresetMenuOpen(false);
											onAskMentor(cell, index, { preset });
										}}
										className="block w-full cursor-pointer rounded px-2 py-1 text-left text-foreground hover:bg-accent"
									>
										{label}
									</button>
								))}
							</div>
						)}
					</div>
					<CellOrderMenu
						index={index}
						totalCells={totalCells}
						onMoveUp={() => onMoveUp(cell.id)}
						onMoveDown={() => onMoveDown(cell.id)}
						onInsertBelow={(kind) => onInsertBelow(cell.id, kind)}
						onDelete={() => onDelete(cell.id)}
					/>
				</div>
			</div>

			{/* Predict-before-Run prompt banner */}
			{isPredict && cell.prediction && (
				<div className="border-b border-border/60 bg-background/50 px-3 py-2.5 text-xs" data-testid={`lab-predict-${cell.id}`}>
					<p className="mb-1.5 font-medium text-foreground">{cell.prediction.prompt}</p>
					{predictionLocked ? (
						<div className="flex flex-wrap items-center gap-2">
							<input
								type="text"
								value={predictionDraft}
								onChange={(e) => setPredictionDraft(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										submitPrediction(false);
									}
								}}
								placeholder="What output or shape do you expect?"
								className="min-w-48 flex-1 rounded border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-muted-foreground"
							/>
							<button
								type="button"
								disabled={!predictionDraft.trim()}
								onClick={() => submitPrediction(false)}
								className="cursor-pointer rounded bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
							>
								Lock prediction & unlock Run
							</button>
							<button
								type="button"
								onClick={() => submitPrediction(true)}
								className="cursor-pointer rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
							>
								Skip
							</button>
						</div>
					) : (
						<div className="flex flex-wrap items-center gap-2 text-muted-foreground">
							<span className="font-medium text-foreground/80">Your prediction:</span>
							<code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs text-foreground">
								{cell.prediction.answer}
							</code>
						</div>
					)}
				</div>
			)}

			{/* CodeMirror 6 editor */}
			<CodeMirrorEditor
				value={cell.source}
				language={language}
				placeholder={isCheck ? "# assert ..." : "# Write Python here (Shift+Enter to run)"}
				ariaLabel={`Code cell ${index + 1}`}
				onChange={(next) =>
					onChange((prev) => ({
						...prev,
						source: next,
						learnerEdited: true,
					}))
				}
				onRunAndAdvance={() => {
					if (!predictionLocked && !running) onRunAndAdvance(cell.id);
				}}
				onRunInPlace={() => {
					if (!predictionLocked && !running) onRun(cell.id);
				}}
			/>

			{isCheck && cell.checkResult?.cases && cell.checkResult.cases.length > 0 && (
				<div
					data-testid={`lab-check-cases-${cell.id}`}
					className="border-t border-border/60 bg-background/40 px-3 py-2 space-y-1 text-[11px]"
				>
					{cell.checkResult.cases.map((c, idx) => (
						<div key={idx} className="flex items-start gap-1.5">
							{c.passed ? (
								<CheckCircle2Icon className="mt-0.5 size-3 shrink-0 text-success" />
							) : (
								<XCircleIcon className="mt-0.5 size-3 shrink-0 text-error" />
							)}
							<div className="min-w-0 flex-1">
								<span className="font-mono text-foreground/90">{c.name}</span>
								{c.line !== undefined && (
									<span className="ml-1.5 font-mono text-[10px] text-muted-foreground">line {c.line}</span>
								)}
								{!c.passed && c.message && (
									<p className="text-error/90">{c.message}</p>
								)}
							</div>
						</div>
					))}
				</div>
			)}

			<CellOutputs
				outputs={cell.outputs}
				onOpenImage={onOpenImage}
				onDebugError={(errText) => onAskMentor(cell, index, { errorSummary: errText, preset: "hint" })}
			/>
		</div>
	);
}

function CellOrderMenu({
	index,
	totalCells,
	onMoveUp,
	onMoveDown,
	onInsertBelow,
	onDelete,
}: {
	index: number;
	totalCells: number;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onInsertBelow: (kind: "code" | "markdown") => void;
	onDelete: () => void;
}) {
	return (
		<div className="flex items-center gap-0.5">
			<button
				type="button"
				disabled={index === 0}
				onClick={onMoveUp}
				title="Move cell up"
				aria-label="Move cell up"
				className="cursor-pointer rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-30"
			>
				<ArrowUpIcon className="size-3" />
			</button>
			<button
				type="button"
				disabled={index >= totalCells - 1}
				onClick={onMoveDown}
				title="Move cell down"
				aria-label="Move cell down"
				className="cursor-pointer rounded p-1 hover:bg-accent hover:text-foreground disabled:opacity-30"
			>
				<ArrowDownIcon className="size-3" />
			</button>
			<button
				type="button"
				onClick={() => onInsertBelow("code")}
				title="Insert code cell below"
				aria-label="Insert code cell below"
				className="cursor-pointer rounded p-1 hover:bg-accent hover:text-foreground"
			>
				<PlusIcon className="size-3" />
			</button>
			<button
				type="button"
				disabled={totalCells <= 1}
				onClick={onDelete}
				title="Delete cell"
				aria-label="Delete cell"
				className="cursor-pointer rounded p-1 hover:bg-accent hover:text-error disabled:opacity-30"
			>
				<Trash2Icon className="size-3" />
			</button>
		</div>
	);
}
