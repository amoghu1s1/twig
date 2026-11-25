"use client";

import { useEffect, useMemo, useState } from "react";
import { FileCode2Icon, XIcon } from "lucide-react";
import {
	buildImportStatement,
	extractTopLevelPythonSymbols,
	suggestModuleFilename,
	type LabCell,
	type LabWorkspaceFile,
} from "@/src/core";

export function ExtractModuleDialog({
	open,
	chatId,
	cell,
	existingFiles,
	onClose,
	onExtracted,
}: {
	open: boolean;
	chatId: string;
	cell: LabCell | null;
	existingFiles: readonly LabWorkspaceFile[];
	onClose: () => void;
	onExtracted: (info: {
		cellId: string;
		relPath: string;
		replaceWithImport: boolean;
		importStatement: string;
	}) => void;
}) {
	const pyFiles = useMemo(
		() => existingFiles.filter((f) => f.kind === "file" && f.path.endsWith(".py")),
		[existingFiles],
	);
	const symbols = useMemo(
		() => (cell ? extractTopLevelPythonSymbols(cell.source) : []),
		[cell],
	);

	const [mode, setMode] = useState<"new" | "append">("new");
	const [filename, setFilename] = useState("helpers.py");
	const [appendTarget, setAppendTarget] = useState("");
	const [replaceWithImport, setReplaceWithImport] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || !cell) return;
		setMode("new");
		setFilename(suggestModuleFilename(cell.source, cell.title));
		setAppendTarget(pyFiles[0]?.path ?? "");
		setReplaceWithImport(true);
		setError(null);
	}, [open, cell, pyFiles]);

	if (!open || !cell) return null;

	const relPath = mode === "append" ? appendTarget.trim() : filename.trim();
	const importStatement = buildImportStatement(relPath, symbols);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!relPath || !relPath.endsWith(".py")) {
			setError("Enter a workspace filename ending in .py");
			return;
		}
		setSaving(true);
		setError(null);
		try {
			const encoded = relPath.split("/").map(encodeURIComponent).join("/");
			let nextContent = `${cell.source.trimEnd()}\n`;
			if (mode === "append") {
				const existingRes = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files/${encoded}`);
				if (existingRes.ok) {
					const existingData = (await existingRes.json()) as { content?: string };
					const base = (existingData.content ?? "").trimEnd();
					nextContent = base ? `${base}\n\n${nextContent}` : nextContent;
				}
			}
			const putRes = await fetch(`/api/labs/${encodeURIComponent(chatId)}/files/${encoded}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: nextContent }),
			});
			const putData = (await putRes.json()) as { path?: string; error?: string };
			if (!putRes.ok) throw new Error(putData.error ?? "Could not write module file");

			const savedPath = putData.path ?? relPath;
			onExtracted({
				cellId: cell.id,
				relPath: savedPath,
				replaceWithImport,
				importStatement: buildImportStatement(savedPath, symbols),
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not extract module");
		} finally {
			setSaving(false);
		}
	};

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Extract cell to Python module"
			data-testid="lab-extract-dialog"
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4"
		>
			<form
				onSubmit={(e) => void handleSubmit(e)}
				className="w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-xl space-y-3 text-xs"
			>
				<div className="flex items-center justify-between gap-2">
					<div className="flex items-center gap-2 font-medium text-sm text-foreground">
						<FileCode2Icon className="size-4 text-muted-foreground" />
						Extract cell to .py module
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="Close"
						className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-4" />
					</button>
				</div>

				{symbols.length > 0 && (
					<div className="text-[11px] text-muted-foreground">
						Detected symbols:{" "}
						<span className="font-mono text-foreground">{symbols.join(", ")}</span>
					</div>
				)}

				{pyFiles.length > 0 && (
					<div className="flex items-center gap-2">
						<button
							type="button"
							onClick={() => setMode("new")}
							className={`cursor-pointer rounded border px-2.5 py-1 text-[11px] ${
								mode === "new" ? "border-border bg-accent text-foreground" : "border-border/60 text-muted-foreground"
							}`}
						>
							New file
						</button>
						<button
							type="button"
							onClick={() => setMode("append")}
							className={`cursor-pointer rounded border px-2.5 py-1 text-[11px] ${
								mode === "append" ? "border-border bg-accent text-foreground" : "border-border/60 text-muted-foreground"
							}`}
						>
							Append to existing
						</button>
					</div>
				)}

				{mode === "new" ? (
					<label className="block space-y-1">
						<span className="text-[11px] text-muted-foreground">Module filename (relative to Lab folder)</span>
						<input
							type="text"
							value={filename}
							onChange={(e) => setFilename(e.target.value)}
							placeholder="helpers.py"
							autoFocus
							className="w-full rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-muted-foreground"
						/>
					</label>
				) : (
					<label className="block space-y-1">
						<span className="text-[11px] text-muted-foreground">Target .py file</span>
						<select
							value={appendTarget}
							onChange={(e) => setAppendTarget(e.target.value)}
							className="w-full rounded border border-border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none"
						>
							{pyFiles.map((f) => (
								<option key={f.path} value={f.path}>
									{f.path}
								</option>
							))}
						</select>
					</label>
				)}

				<label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
					<input
						type="checkbox"
						checked={replaceWithImport}
						onChange={(e) => setReplaceWithImport(e.target.checked)}
						className="rounded border-border accent-primary"
					/>
					Replace cell code with <code className="rounded bg-background px-1 py-0.5 font-mono text-[11px]">{importStatement}</code>
				</label>

				{error && <p className="text-[11px] text-error">{error}</p>}

				<div className="flex items-center justify-end gap-2 pt-1">
					<button
						type="button"
						onClick={onClose}
						className="cursor-pointer rounded border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						Cancel
					</button>
					<button
						type="submit"
						disabled={saving || !relPath.endsWith(".py")}
						className="cursor-pointer rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-40"
					>
						{saving ? "Extracting…" : "Extract"}
					</button>
				</div>
			</form>
		</div>
	);
}
