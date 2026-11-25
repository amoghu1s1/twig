"use client";

import { useState, type ReactNode, type Ref } from "react";
import { DumbbellIcon, FolderOpenIcon, PencilIcon } from "lucide-react";

/** Home and the draft share one wrapping action row. Picker controls lead;
 * setup is centered only when it is the sole action. */
export function ComposerActions({ picker, setup }: { picker?: ReactNode; setup?: ReactNode }) {
	if (!picker && !setup) return null;
	return (
		<div
			data-testid="composer-actions"
			className={`pointer-events-auto mb-2 flex flex-wrap items-center gap-2 ${picker ? "justify-start" : "justify-center"}`}
		>
			{picker}
			{setup}
		</div>
	);
}

/** Count and Clear stay together if the setup action wraps onto another line.
 * These are node counts, even when a whole chain supplied the selection. */
export function NodePickerControl({ count, onOpen, onClear, emptyLabel = "Pick nodes", disabled, triggerRef }: {
	count: number;
	/** Optional label while nothing is picked. */
	emptyLabel?: string;
	onOpen?: () => void;
	onClear?: () => void;
	disabled?: boolean;
	triggerRef?: Ref<HTMLButtonElement>;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-testid="practice-props-chip"
				ref={triggerRef}
				disabled={disabled}
				onClick={onOpen}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(count > 0
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<DumbbellIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				{count > 0 ? `${count} ${count === 1 ? "node" : "nodes"} selected` : emptyLabel}
			</button>
			{count > 0 && (
				<button
					type="button"
					data-testid="practice-props-clear"
					disabled={disabled}
					onClick={onClear}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}

/** Optional workspace folder picker for new Twig Lab sessions. When left unset,
 *  the server provisions `~/Documents/Twig Labs/<slug>/`. */
export function LabFolderControl({
	workspaceDir,
	onChange,
	disabled,
}: {
	workspaceDir: string;
	onChange: (dir: string) => void;
	disabled?: boolean;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(workspaceDir);

	const trimmed = workspaceDir.trim();
	const displayName = trimmed
		? trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed
		: "Auto folder";

	const openEditor = () => {
		setDraft(workspaceDir);
		setEditing(true);
	};

	const pickNativeFolder = async () => {
		if (disabled) return;
		const bridge = typeof window !== "undefined" ? (window as unknown as { lh?: { chooseAttachmentFolder?: () => Promise<string | null> } }).lh : undefined;
		if (bridge?.chooseAttachmentFolder) {
			try {
				const chosen = await bridge.chooseAttachmentFolder();
				if (chosen) {
					onChange(chosen);
					setEditing(false);
					return;
				}
			} catch {
				// Fall back to inline path input.
			}
		}
		openEditor();
	};

	if (editing) {
		return (
			<div className="flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 font-ui text-xs">
				<FolderOpenIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
				<input
					type="text"
					data-testid="lab-folder-input"
					value={draft}
					disabled={disabled}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							onChange(draft.trim());
							setEditing(false);
						} else if (e.key === "Escape") {
							e.preventDefault();
							setEditing(false);
						}
					}}
					placeholder="~/Documents/Twig Labs/..."
					aria-label="Lab workspace folder path"
					autoFocus
					className="w-44 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
				/>
				<button
					type="button"
					onClick={() => {
						onChange(draft.trim());
						setEditing(false);
					}}
					className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-accent"
				>
					Set
				</button>
				<button
					type="button"
					onClick={() => setEditing(false)}
					className="cursor-pointer rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					Cancel
				</button>
			</div>
		);
	}

	return (
		<div className="flex items-center gap-1">
			<button
				type="button"
				data-testid="lab-folder-chip"
				disabled={disabled}
				onClick={() => void pickNativeFolder()}
				title={trimmed || "Choose or type a local folder for this Lab (defaults to ~/Documents/Twig Labs/<slug>)"}
				className={
					"flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 font-ui text-xs transition-colors " +
					(trimmed
						? "border-border bg-card text-foreground hover:bg-accent"
						: "border-dashed border-border/80 bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground")
				}
			>
				<FolderOpenIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
				<span className="max-w-[14rem] truncate">{displayName}</span>
			</button>
			<button
				type="button"
				data-testid="lab-folder-edit"
				disabled={disabled}
				onClick={openEditor}
				title="Enter folder path"
				aria-label="Enter Lab workspace folder path"
				className="cursor-pointer rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				<PencilIcon className="size-3" />
			</button>
			{trimmed && (
				<button
					type="button"
					data-testid="lab-folder-clear"
					disabled={disabled}
					onClick={() => onChange("")}
					className="cursor-pointer rounded-full px-2 py-1 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					Clear
				</button>
			)}
		</div>
	);
}
