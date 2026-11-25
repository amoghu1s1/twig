"use client";

import { useEffect, useState } from "react";
import { FolderOpenIcon } from "lucide-react";
import type { LabNudgeLevel, LabSettings, PythonEnvInfo } from "@/src/core";
import { CommitInput, SettingsGroup, SettingsRow, ThinSelect, type SettingsCommitResult } from "./controls.tsx";

/**
 * Twig Lab defaults rendered inside Settings -> General so the 6-tab settings
 * rail stays unchanged while giving learners control over their notebook root
 * folder and default Python interpreter.
 */
export function LabSettingsRows({
	lab,
	onLabChange,
}: {
	lab?: LabSettings;
	onLabChange: (next: LabSettings) => SettingsCommitResult;
}) {
	const [envs, setEnvs] = useState<PythonEnvInfo[]>([]);
	const [canPickFolder, setCanPickFolder] = useState(false);

	useEffect(() => {
		const bridge = typeof window !== "undefined"
			? (window as unknown as { lh?: { chooseAttachmentFolder?: () => Promise<string | null> } }).lh
			: undefined;
		setCanPickFolder(typeof bridge?.chooseAttachmentFolder === "function");

		let cancelled = false;
		void fetch("/api/labs/envs")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { envs?: PythonEnvInfo[] } | null) => {
				if (!cancelled && Array.isArray(body?.envs)) {
					setEnvs(body.envs);
				}
			})
			.catch(() => {
				// Interpreter discovery is best-effort inside Settings.
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const currentRoot = lab?.defaultRootDir ?? "";
	const currentPython = lab?.pythonPath ?? "";
	const currentNudge: LabNudgeLevel = lab?.defaultNudgeLevel ?? "nudge";
	const pythonInList = currentPython === "" || envs.some((e) => e.path === currentPython);

	return (
		<SettingsGroup label="Twig Lab" testid="group-lab">
			<SettingsRow
				label="Default workspace folder"
				hint="Where auto-created Lab notebooks live (defaults to ~/Documents/Twig Labs)"
				testid="row-lab-root"
			>
				<div className="flex items-center gap-1.5">
					<CommitInput
						value={currentRoot}
						placeholder="~/Documents/Twig Labs"
						ariaLabel="Default Lab workspace folder"
						testid="input-lab-root"
						onCommit={(next) => onLabChange({ ...lab, defaultRootDir: next })}
					/>
					{canPickFolder && (
						<button
							type="button"
							data-testid="button-lab-root-browse"
							onClick={async () => {
								const bridge = (window as unknown as { lh?: { chooseAttachmentFolder?: () => Promise<string | null> } }).lh;
								const picked = await bridge?.chooseAttachmentFolder?.();
								if (picked) {
									await onLabChange({ ...lab, defaultRootDir: picked });
								}
							}}
							title="Choose folder"
							aria-label="Browse default Lab workspace folder"
							className="flex h-7 cursor-pointer items-center gap-1 rounded-sm border border-border bg-background px-2 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50 hover:bg-accent"
						>
							<FolderOpenIcon className="size-3.5 text-muted-foreground" />
							Browse
						</button>
					)}
				</div>
			</SettingsRow>
			<SettingsRow
				label="Default Python interpreter"
				hint="Interpreter path used for new Lab sessions (auto-detected if blank)"
				testid="row-lab-python"
			>
				<div className="flex items-center gap-1.5">
					<ThinSelect
						value={currentPython}
						ariaLabel="Discovered Python interpreters"
						testid="select-lab-python"
						onChange={(next) => {
							void onLabChange({ ...lab, pythonPath: next });
						}}
					>
						<option value="">Auto-detect</option>
						{envs.map((env) => (
							<option key={env.path} value={env.path}>
								{env.label} (Python {env.version})
							</option>
						))}
						{!pythonInList && (
							<option value={currentPython}>Custom ({currentPython})</option>
						)}
					</ThinSelect>
					<CommitInput
						value={currentPython}
						placeholder="Auto-detect or enter path"
						ariaLabel="Custom Python interpreter path"
						testid="input-lab-python"
						onCommit={(next) => onLabChange({ ...lab, pythonPath: next })}
					/>
				</div>
			</SettingsRow>
			<SettingsRow
				label="Default coaching mode"
				hint="How aggressively the mentor scopes feedback on failing cells"
				testid="row-lab-nudge"
			>
				<ThinSelect
					value={currentNudge}
					ariaLabel="Default Lab coaching mode"
					testid="select-lab-nudge"
					onChange={(next) => {
						if (next === "nudge" || next === "balanced" || next === "direct") {
							void onLabChange({ ...lab, defaultNudgeLevel: next });
						}
					}}
				>
					<option value="nudge">Nudge first (diagnostic pointer)</option>
					<option value="balanced">Balanced (pointer + API hint)</option>
					<option value="direct">Direct (pair programming)</option>
				</ThinSelect>
			</SettingsRow>
		</SettingsGroup>
	);
}
