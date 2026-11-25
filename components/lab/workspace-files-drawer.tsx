"use client";

import { useCallback, useEffect, useState } from "react";
import {
	ArrowRightFromLineIcon,
	FileCode2Icon,
	FileTextIcon,
	FolderIcon,
	FolderPlusIcon,
	PencilIcon,
	PlusIcon,
	RefreshCwIcon,
	SaveIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import type { LabWorkspaceFile } from "@/src/core";
import { CodeMirrorEditor } from "./code-mirror-editor";

export function WorkspaceFilesDrawer({
	chatId,
	open,
	onClose,
	refreshToken = 0,
	onInsertImport,
}: {
	chatId: string;
	open: boolean;
	onClose: () => void;
	refreshToken?: number;
	onInsertImport?: (relPath: string) => void;
}) {
	const [files, setFiles] = useState<LabWorkspaceFile[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [activePath, setActivePath] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState("");
	const [savedContent, setSavedContent] = useState("");
	const [saving, setSaving] = useState(false);
	const [creatingName, setCreatingName] = useState("");
	const [showCreate, setShowCreate] = useState(false);
	const [creatingFolder, setCreatingFolder] = useState("");
	const [showCreateFolder, setShowCreateFolder] = useState(false);
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");

	const loadFiles = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files`);
			const data = (await res.json()) as { files?: LabWorkspaceFile[]; error?: string };
			if (!res.ok) throw new Error(data.error ?? "Failed to list files");
			setFiles(data.files ?? []);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not list files");
		} finally {
			setLoading(false);
		}
	}, [chatId]);

	useEffect(() => {
		if (open) void loadFiles();
	}, [open, refreshToken, loadFiles]);

	const openFile = async (relPath: string) => {
		if (relPath === "notebook.ipynb") return;
		setError(null);
		try {
			const encoded = relPath.split("/").map(encodeURIComponent).join("/");
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files/${encoded}`);
			const data = (await res.json()) as { content?: string; error?: string };
			if (!res.ok) throw new Error(data.error ?? "Could not open file");
			setActivePath(relPath);
			setFileContent(data.content ?? "");
			setSavedContent(data.content ?? "");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not open file");
		}
	};

	const saveActiveFile = async () => {
		if (!activePath) return;
		setSaving(true);
		setError(null);
		try {
			const encoded = activePath.split("/").map(encodeURIComponent).join("/");
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files/${encoded}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: fileContent }),
			});
			const data = (await res.json()) as { error?: string };
			if (!res.ok) throw new Error(data.error ?? "Could not save file");
			setSavedContent(fileContent);
			void loadFiles();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not save file");
		} finally {
			setSaving(false);
		}
	};

	const createFile = async () => {
		const rel = creatingName.trim();
		if (!rel) return;
		setError(null);
		try {
			const encoded = rel.split("/").map(encodeURIComponent).join("/");
			const starter = rel.endsWith(".py") ? "# Local helper module\n" : "";
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files/${encoded}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: starter }),
			});
			const data = (await res.json()) as { path?: string; error?: string };
			if (!res.ok) throw new Error(data.error ?? "Could not create file");
			setShowCreate(false);
			setCreatingName("");
			await loadFiles();
			if (data.path) void openFile(data.path);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not create file");
		}
	};

	const deleteFile = async (relPath: string) => {
		setError(null);
		try {
			const encoded = relPath.split("/").map(encodeURIComponent).join("/");
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files/${encoded}`, {
				method: "DELETE",
			});
			const data = (await res.json()) as { error?: string };
			if (!res.ok) throw new Error(data.error ?? "Could not delete file");
			if (activePath === relPath) setActivePath(null);
			void loadFiles();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not delete file");
		}
	};

	const createFolder = async () => {
		const rel = creatingFolder.trim();
		if (!rel) return;
		setError(null);
		try {
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind: "folder", path: rel }),
			});
			const data = (await res.json()) as { error?: string };
			if (!res.ok) throw new Error(data.error ?? "Could not create folder");
			setShowCreateFolder(false);
			setCreatingFolder("");
			await loadFiles();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not create folder");
		}
	};

	const commitRename = async () => {
		if (!renamingPath) return;
		const nextPath = renameDraft.trim();
		if (!nextPath || nextPath === renamingPath) {
			setRenamingPath(null);
			return;
		}
		setError(null);
		try {
			const encoded = renamingPath.split("/").map(encodeURIComponent).join("/");
			const res = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files/${encoded}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ renameTo: nextPath }),
			});
			const data = (await res.json()) as { path?: string; error?: string };
			if (!res.ok) throw new Error(data.error ?? "Could not rename");
			if (activePath === renamingPath && data.path) setActivePath(data.path);
			setRenamingPath(null);
			await loadFiles();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not rename");
		}
	};

	if (!open) return null;

	const dirty = activePath !== null && fileContent !== savedContent;

	return (
		<aside
			data-testid="lab-files-drawer"
			className="flex w-64 shrink-0 flex-col border-r border-border bg-card/50"
		>
			<div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
					Workspace Files
				</span>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => {
							setShowCreateFolder(false);
							setShowCreate((s) => !s);
						}}
						title="New file"
						aria-label="New file"
						className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<PlusIcon className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={() => {
							setShowCreate(false);
							setShowCreateFolder((s) => !s);
						}}
						title="New folder"
						aria-label="New folder"
						data-testid="lab-new-folder-btn"
						className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<FolderPlusIcon className="size-3.5" />
					</button>
					<button
						type="button"
						onClick={() => void loadFiles()}
						title="Refresh files"
						aria-label="Refresh files"
						className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<RefreshCwIcon className="size-3" />
					</button>
					<button
						type="button"
						onClick={onClose}
						title="Close files drawer"
						aria-label="Close files drawer"
						className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-3.5" />
					</button>
				</div>
			</div>

			{showCreate && (
				<div className="border-b border-border/70 p-2">
					<input
						type="text"
						value={creatingName}
						onChange={(e) => setCreatingName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void createFile();
							if (e.key === "Escape") setShowCreate(false);
						}}
						placeholder="helpers.py"
						autoFocus
						className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-muted-foreground"
					/>
				</div>
			)}

			{showCreateFolder && (
				<div className="border-b border-border/70 p-2">
					<input
						type="text"
						value={creatingFolder}
						onChange={(e) => setCreatingFolder(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void createFolder();
							if (e.key === "Escape") setShowCreateFolder(false);
						}}
						placeholder="src/sim"
						autoFocus
						className="w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-muted-foreground"
					/>
				</div>
			)}

			{error && <p className="px-3 py-1.5 text-[11px] text-error">{error}</p>}

			<div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5 space-y-0.5">
				{loading && files.length === 0 ? (
					<p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>
				) : files.length === 0 ? (
					<p className="px-2 py-2 text-xs text-muted-foreground">No files yet.</p>
				) : (
					files.map((item) => {
						const isActive = activePath === item.path;
						const isNotebook = item.path === "notebook.ipynb";
						const isPy = item.kind === "file" && item.name.endsWith(".py");
						if (renamingPath === item.path) {
							return (
								<div key={item.path} className="px-1 py-0.5">
									<input
										type="text"
										value={renameDraft}
										onChange={(e) => setRenameDraft(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter") void commitRename();
											if (e.key === "Escape") setRenamingPath(null);
										}}
										onBlur={() => void commitRename()}
										autoFocus
										className="w-full rounded border border-border bg-background px-2 py-0.5 font-mono text-[11px] text-foreground outline-none"
									/>
								</div>
							);
						}
						return (
							<div
								key={item.path}
								className={`group flex items-center justify-between gap-1 rounded px-2 py-1 text-xs ${
									isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
								}`}
							>
								<button
									type="button"
									disabled={item.kind === "dir" || (!item.editable && !isNotebook)}
									onClick={() => {
										if (isNotebook) setActivePath(null);
										else if (item.editable) void openFile(item.path);
									}}
									className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left disabled:cursor-default"
								>
									{item.kind === "dir" ? (
										<FolderIcon className="size-3.5 shrink-0" />
									) : isPy ? (
										<FileCode2Icon className="size-3.5 shrink-0" />
									) : (
										<FileTextIcon className="size-3.5 shrink-0" />
									)}
									<span className="truncate font-mono text-[11px]">{item.path}</span>
								</button>
								<div className="flex items-center gap-0.5">
									{isPy && onInsertImport && (
										<button
											type="button"
											onClick={() => onInsertImport(item.path)}
											title={`Insert import for ${item.name} into notebook`}
											aria-label={`Insert import for ${item.name}`}
											data-testid={`lab-insert-import-${item.path}`}
											className="cursor-pointer rounded p-0.5 opacity-0 hover:text-foreground group-hover:opacity-100"
										>
											<ArrowRightFromLineIcon className="size-3" />
										</button>
									)}
									{item.kind === "file" && !isNotebook && (
										<>
											<button
												type="button"
												onClick={() => {
													setRenamingPath(item.path);
													setRenameDraft(item.path);
												}}
												title={`Rename ${item.name}`}
												aria-label={`Rename ${item.name}`}
												className="cursor-pointer rounded p-0.5 opacity-0 hover:text-foreground group-hover:opacity-100"
											>
												<PencilIcon className="size-3" />
											</button>
											<button
												type="button"
												onClick={() => void deleteFile(item.path)}
												title={`Delete ${item.name}`}
												aria-label={`Delete ${item.name}`}
												className="cursor-pointer rounded p-0.5 opacity-0 hover:text-error group-hover:opacity-100"
											>
												<Trash2Icon className="size-3" />
											</button>
										</>
									)}
								</div>
							</div>
						);
					})
				)}
			</div>

			{activePath && (
				<div className="flex h-64 shrink-0 flex-col border-t border-border bg-background">
					<div className="flex items-center justify-between gap-2 border-b border-border/70 px-2.5 py-1.5 text-[11px]">
						<span className="truncate font-mono text-foreground">
							{activePath}{dirty ? " *" : ""}
						</span>
						<div className="flex items-center gap-1">
							<button
								type="button"
								disabled={!dirty || saving}
								onClick={() => void saveActiveFile()}
								className="inline-flex cursor-pointer items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11px] text-foreground disabled:opacity-40"
							>
								<SaveIcon className="size-3" />
								{saving ? "Saving…" : "Save"}
							</button>
							<button
								type="button"
								onClick={() => setActivePath(null)}
								aria-label="Close file editor"
								className="cursor-pointer rounded p-0.5 text-muted-foreground hover:text-foreground"
							>
								<XIcon className="size-3" />
							</button>
						</div>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto">
						<CodeMirrorEditor
							value={fileContent}
							language={activePath.endsWith(".py") ? "python" : "plain"}
							onChange={setFileContent}
							onSave={() => void saveActiveFile()}
							minHeightClassName="min-h-full"
						/>
					</div>
				</div>
			)}

			<div className="border-t border-border/60 px-3 py-1.5 text-[10px] text-muted-foreground">
				Edited .py files auto-reload on next cell run.
			</div>
		</aside>
	);
}
