"use client";

import { useEffect, useRef, useState } from "react";
import {
	ChevronDownIcon,
	DownloadIcon,
	FlagIcon,
	FlaskConicalIcon,
	FolderOpenIcon,
	PlayIcon,
	RefreshCwIcon,
	RotateCcwIcon,
	SquareIcon,
	Table2Icon,
} from "lucide-react";
import { TopBar } from "@/components/top-bar";
import { useOptionalInteractionLayers } from "@/components/interaction-layers";
import { isInteractionScopeEligible } from "@/components/plugin-input-focus";
import {
	DEFAULT_LAB_NUDGE_LEVEL,
	type KernelStatus,
	type LabNudgeLevel,
	type LabSessionMeta,
	type PythonEnvInfo,
} from "@/src/core";

const NUDGE_MODES: ReadonlyArray<{ value: LabNudgeLevel; label: string; title: string }> = [
	{ value: "nudge", label: "Nudge", title: "Diagnostic pointer on first failure; full fix only on retry or request" },
	{ value: "balanced", label: "Balanced", title: "Diagnostic pointer plus a short API hint" },
	{ value: "direct", label: "Direct", title: "Pair programming with immediate repair code" },
];

export function LabToolbar({
	chatId,
	title,
	onRename,
	meta,
	kernelStatus,
	busyCellId,
	envs,
	envsLoading,
	filesOpen,
	variablesOpen,
	onToggleFiles,
	onToggleVariables,
	onRunAll,
	onInterrupt,
	onRestart,
	onRefreshEnvs,
	onSelectInterpreter,
	onChangeWorkspaceDir,
	onChangeNudgeLevel,
	onWrapUp,
	onDownloadIpynb,
}: {
	chatId: string;
	title: string;
	onRename: (nextTitle: string) => Promise<void>;
	meta: LabSessionMeta;
	kernelStatus: KernelStatus;
	busyCellId: string | null;
	envs: readonly PythonEnvInfo[];
	envsLoading: boolean;
	filesOpen: boolean;
	variablesOpen: boolean;
	onToggleFiles: () => void;
	onToggleVariables: () => void;
	onRunAll: () => void;
	onInterrupt: () => void;
	onRestart: () => void;
	onRefreshEnvs: () => void;
	onSelectInterpreter: (path: string) => Promise<void>;
	onChangeWorkspaceDir: (dir: string) => Promise<void>;
	onChangeNudgeLevel?: (level: LabNudgeLevel) => Promise<void> | void;
	onWrapUp?: () => void;
	onDownloadIpynb: () => void;
}) {
	const controller = useOptionalInteractionLayers();
	const [renaming, setRenaming] = useState(false);
	const [titleDraft, setTitleDraft] = useState(title);
	const titleInputRef = useRef<HTMLInputElement | null>(null);
	const [envMenuOpen, setEnvMenuOpen] = useState(false);
	const [wsMenuOpen, setWsMenuOpen] = useState(false);
	const [customPython, setCustomPython] = useState("");
	const [customDir, setCustomDir] = useState(meta.workspaceDir);
	const [menuError, setMenuError] = useState<string | null>(null);
	const envMenuRef = useRef<HTMLDivElement | null>(null);
	const wsMenuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		setCustomDir(meta.workspaceDir);
	}, [meta.workspaceDir]);

	useEffect(() => {
		if (!envMenuOpen && !wsMenuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (envMenuOpen && envMenuRef.current && !envMenuRef.current.contains(e.target as Node)) {
				setEnvMenuOpen(false);
			}
			if (wsMenuOpen && wsMenuRef.current && !wsMenuRef.current.contains(e.target as Node)) {
				setWsMenuOpen(false);
			}
		};
		window.addEventListener("mousedown", onDown);
		return () => window.removeEventListener("mousedown", onDown);
	}, [envMenuOpen, wsMenuOpen]);

	const activeEnv = envs.find((e) => e.path === meta.interpreterPath);
	const envLabel = activeEnv?.label ?? (meta.interpreterPath ? meta.interpreterPath.split(/[\\/]/).slice(-2).join("/") : "Python 3");
	const activeNudge: LabNudgeLevel = meta.nudgeLevel ?? DEFAULT_LAB_NUDGE_LEVEL;

	const statusDotColor =
		kernelStatus === "busy" || kernelStatus === "starting"
			? "bg-warning"
			: kernelStatus === "idle"
				? "bg-success"
				: kernelStatus === "error"
					? "bg-error"
					: "bg-muted-foreground/50";

	const commitRename = async () => {
		setRenaming(false);
		const trimmed = titleDraft.trim();
		if (trimmed && trimmed !== title) await onRename(trimmed);
	};

	const pickFolder = async () => {
		setMenuError(null);
		const chosen = await window.lh?.chooseAttachmentFolder?.();
		if (chosen) {
			setCustomDir(chosen);
			try {
				await onChangeWorkspaceDir(chosen);
				setWsMenuOpen(false);
			} catch (err) {
				setMenuError(err instanceof Error ? err.message : "Could not bind folder");
			}
		}
	};

	return (
		<TopBar
			drag={!renaming}
			onMouseDown={(e) => {
				if (renaming && e.target !== titleInputRef.current) titleInputRef.current?.blur();
			}}
		>
			{renaming ? (
				<input
					ref={titleInputRef}
					value={titleDraft}
					onChange={(e) => setTitleDraft(e.target.value)}
					onKeyDown={(e) => {
						if (!isInteractionScopeEligible(e.currentTarget, controller)) return;
						if (e.key === "Enter") void commitRename();
						else if (e.key === "Escape") {
							controller?.claimEscape(e);
							e.stopPropagation();
							setRenaming(false);
						}
					}}
					onBlur={() => void commitRename()}
					spellCheck={false}
					autoFocus
					aria-label="Lab title"
					className="lh-no-drag min-w-[8ch] max-w-[36ch] shrink bg-transparent font-title text-2xl tracking-tight caret-current outline-none"
				/>
			) : (
				<button
					type="button"
					onClick={() => {
						setTitleDraft(title);
						setRenaming(true);
					}}
					className="lh-no-drag -mx-1.5 min-w-4 max-w-[28rem] shrink cursor-text truncate rounded-md px-1.5 text-left font-title text-2xl tracking-tight transition-colors hover:bg-accent"
				>
					{title}
				</button>
			)}

			<span
				data-testid="phase-chip"
				data-phase="lab"
				className="inline-flex shrink-0 select-none items-center gap-1 rounded-full border border-border/70 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
			>
				<FlaskConicalIcon className="size-3" />
				Lab
			</span>

			<div className="min-w-2 flex-1" aria-hidden="true" />

			{/* Coaching Nudge Level Selector */}
			{onChangeNudgeLevel && (
				<div
					role="group"
					aria-label="Coaching nudge level"
					data-testid="lab-nudge-picker"
					className="lh-no-drag hidden shrink-0 items-center gap-0.5 rounded-md border border-border/70 bg-background p-0.5 md:flex"
				>
					{NUDGE_MODES.map((m) => (
						<button
							key={m.value}
							type="button"
							title={m.title}
							aria-pressed={activeNudge === m.value}
							data-testid={`lab-nudge-${m.value}`}
							onClick={() => void onChangeNudgeLevel(m.value)}
							className={`cursor-pointer rounded-sm px-2 py-0.5 text-[11px] font-medium transition-colors ${
								activeNudge === m.value
									? "bg-accent text-foreground"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							{m.label}
						</button>
					))}
				</div>
			)}

			{/* Kernel & Interpreter Picker */}
			<div ref={envMenuRef} className="relative shrink-0">
				<button
					type="button"
					data-testid="lab-kernel-picker"
					onClick={() => {
						setMenuError(null);
						setEnvMenuOpen((o) => {
							if (!o) onRefreshEnvs();
							return !o;
						});
					}}
					className="lh-no-drag inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border/80 bg-card px-2.5 py-1 font-mono text-[11px] text-foreground transition-colors hover:bg-accent"
				>
					<span className={`size-2 rounded-full ${statusDotColor}`} />
					<span className="max-w-52 truncate">{envLabel}</span>
					<ChevronDownIcon className="size-3 text-muted-foreground" />
				</button>

				{envMenuOpen && (
					<div className="absolute right-0 top-full z-40 mt-1.5 w-80 rounded-lg border border-border bg-card p-2 shadow-xl">
						<div className="mb-1.5 flex items-center justify-between px-1">
							<span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
								Python Environment
							</span>
							<button
								type="button"
								onClick={onRefreshEnvs}
								className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
								aria-label="Refresh Python environments"
							>
								<RefreshCwIcon className={`size-3 ${envsLoading ? "animate-spin" : ""}`} />
							</button>
						</div>

						{menuError && <p className="mb-1.5 px-1 text-[11px] text-error">{menuError}</p>}

						<div className="max-h-56 space-y-1 overflow-y-auto">
							{envs.map((env) => {
								const selected = env.path === meta.interpreterPath;
								return (
									<button
										key={env.path}
										type="button"
										onClick={() => {
											setMenuError(null);
											void onSelectInterpreter(env.path)
												.then(() => setEnvMenuOpen(false))
												.catch((err) => setMenuError(err instanceof Error ? err.message : "Failed"));
										}}
										className={`w-full cursor-pointer rounded px-2 py-1.5 text-left text-xs transition-colors ${
											selected ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
										}`}
									>
										<div className="truncate font-medium text-foreground">{env.label}</div>
										<div className="truncate font-mono text-[10px] text-muted-foreground">{env.path}</div>
									</button>
								);
							})}
						</div>

						<div className="mt-2 border-t border-border/60 pt-2">
							<div className="flex items-center gap-1.5">
								<input
									type="text"
									value={customPython}
									onChange={(e) => setCustomPython(e.target.value)}
									placeholder="/path/to/.venv/bin/python"
									className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none"
								/>
								<button
									type="button"
									disabled={!customPython.trim()}
									onClick={() => {
										setMenuError(null);
										void onSelectInterpreter(customPython.trim())
											.then(() => {
												setCustomPython("");
												setEnvMenuOpen(false);
											})
											.catch((err) => setMenuError(err instanceof Error ? err.message : "Invalid Python path"));
									}}
									className="cursor-pointer rounded bg-accent px-2 py-1 text-[11px] text-foreground disabled:opacity-40"
								>
									Use
								</button>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Run All / Interrupt / Restart */}
			{busyCellId ? (
				<button
					type="button"
					onClick={onInterrupt}
					data-testid="lab-interrupt"
					className="lh-no-drag inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-error/40 bg-error/10 px-2.5 py-1 text-xs font-medium text-error transition-colors hover:bg-error/20"
				>
					<SquareIcon className="size-3" />
					Interrupt
				</button>
			) : (
				<button
					type="button"
					onClick={onRunAll}
					data-testid="lab-run-all"
					className="lh-no-drag inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/80 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<PlayIcon className="size-3" />
					Run All
				</button>
			)}

			<button
				type="button"
				onClick={onRestart}
				data-testid="lab-restart"
				title="Restart Python kernel"
				className="lh-no-drag inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/80 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<RotateCcwIcon className="size-3" />
				Restart
			</button>

			<button
				type="button"
				onClick={onToggleFiles}
				aria-pressed={filesOpen}
				data-testid="lab-files-toggle"
				className={`lh-no-drag inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors ${
					filesOpen ? "border-border bg-accent text-foreground" : "border-border/80 text-muted-foreground hover:bg-accent hover:text-foreground"
				}`}
			>
				<FolderOpenIcon className="size-3" />
				Files
			</button>

			<button
				type="button"
				onClick={onToggleVariables}
				aria-pressed={variablesOpen}
				className={`lh-no-drag hidden shrink-0 cursor-pointer items-center gap-1 rounded-md border px-2 py-1 text-xs transition-colors sm:inline-flex ${
					variablesOpen ? "border-border bg-accent text-foreground" : "border-border/80 text-muted-foreground hover:bg-accent hover:text-foreground"
				}`}
			>
				<Table2Icon className="size-3" />
				Vars
			</button>

			{onWrapUp && (
				<button
					type="button"
					onClick={onWrapUp}
					data-testid="lab-wrap-up"
					title="Summarize completed milestones and follow-up gaps with the mentor"
					className="lh-no-drag inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border/80 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<FlagIcon className="size-3" />
					<span className="hidden lg:inline">Wrap up</span>
				</button>
			)}

			{/* Workspace folder + Export .ipynb */}
			<div ref={wsMenuRef} className="relative shrink-0">
				<button
					type="button"
					onClick={() => {
						setMenuError(null);
						setWsMenuOpen((o) => !o);
					}}
					className="lh-no-drag inline-flex cursor-pointer items-center gap-1 rounded-md border border-border/80 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<DownloadIcon className="size-3" />
					<span className="hidden md:inline">.ipynb</span>
				</button>

				{wsMenuOpen && (
					<div className="absolute right-0 top-full z-40 mt-1.5 w-80 rounded-lg border border-border bg-card p-3 shadow-xl text-xs">
						<div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
							Bound Workspace Folder
						</div>
						<p className="mb-2 break-all font-mono text-[11px] text-foreground/90">{meta.workspaceDir}</p>
						{menuError && <p className="mb-2 text-[11px] text-error">{menuError}</p>}

						<div className="mb-2 flex items-center gap-1.5">
							<input
								type="text"
								value={customDir}
								onChange={(e) => setCustomDir(e.target.value)}
								aria-label="Workspace folder path"
								className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground outline-none"
							/>
							<button
								type="button"
								onClick={() => {
									setMenuError(null);
									void onChangeWorkspaceDir(customDir)
										.then(() => setWsMenuOpen(false))
										.catch((err) => setMenuError(err instanceof Error ? err.message : "Could not bind folder"));
								}}
								className="cursor-pointer rounded bg-accent px-2 py-1 text-[11px] text-foreground"
							>
								Bind
							</button>
						</div>

						<div className="flex items-center justify-between gap-2 pt-1">
							{typeof window !== "undefined" && window.lh?.chooseAttachmentFolder && (
								<button
									type="button"
									onClick={() => void pickFolder()}
									className="inline-flex cursor-pointer items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-foreground hover:bg-accent"
								>
									<FolderOpenIcon className="size-3" />
									Choose folder…
								</button>
							)}
							<button
								type="button"
								onClick={() => {
									onDownloadIpynb();
									setWsMenuOpen(false);
								}}
								data-testid={`lab-download-${chatId}`}
								className="ml-auto inline-flex cursor-pointer items-center gap-1 rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
							>
								<DownloadIcon className="size-3" />
								Download .ipynb
							</button>
						</div>
					</div>
				)}
			</div>
		</TopBar>
	);
}
