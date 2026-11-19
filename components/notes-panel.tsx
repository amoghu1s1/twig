"use client";

/**
 * The notes panel (notes wave): right of the transcript, toggled by the
 * top bar's Notes chip. Resizable (edge drag / arrow keys / double-click),
 * auto-folded on narrow windows, always mounted so the editor's draft
 * survives folding. The save-error line rides the header.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon, DownloadIcon, EyeIcon, NotebookPenIcon, PanelRightCloseIcon, PencilIcon } from "lucide-react";
import { AssistantTextResponse } from "@/components/ai-elements/message";
import { downloadFile, slugFilename } from "@/components/artifacts/download";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { NotesEditor } from "@/components/notes-editor";
import {
	clampNotesWidth,
	NOTES_DEFAULT_WIDTH,
	NOTES_MAX_WIDTH,
	NOTES_MIN_WIDTH,
} from "@/components/notes-layout";
import { useNotesController, useNotesSnapshot } from "@/components/notes-state";
import { kbdEventForAction } from "@/src/core";

async function copyNotesText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		/* fall through to legacy execCommand path */
	}
	try {
		const ta = document.createElement("textarea");
		ta.value = text;
		ta.setAttribute("readonly", "");
		ta.style.position = "fixed";
		ta.style.opacity = "0";
		document.body.appendChild(ta);
		ta.select();
		const ok = document.execCommand("copy");
		ta.remove();
		return ok;
	} catch {
		return false;
	}
}

export function notesExportFilename(title?: string, root?: HTMLElement | null): string {
	let resolved = title?.trim() ?? "";
	if (!resolved && typeof document !== "undefined") {
		const el =
			root?.parentElement?.querySelector<HTMLElement>("[data-plugin-chrome-title]") ??
			document.querySelector<HTMLElement>("[data-plugin-chrome-title]");
		if (el) {
			resolved = (el.tagName === "INPUT" ? (el as HTMLInputElement).value : el.textContent ?? "").trim();
		}
	}
	const ascii = resolved.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
	const stem = /[a-z0-9]/i.test(ascii) ? slugFilename(resolved) : "session";
	return `${stem}-notes.md`;
}

/** Always mounted so the editor (and its draft) survives folding. */
export function NotesPanel({ title }: { title?: string } = {}) {
	const controller = useNotesController();
	const { visible, width: savedWidth, saveError, text } = useNotesSnapshot();
	const [mounted, setMounted] = useState(false);
	const [preview, setPreview] = useState(false);
	const [copied, setCopied] = useState(false);
	const [dragWidth, setDragWidth] = useState<number | null>(null);
	const panelRef = useRef<HTMLElement | null>(null);
	const editorRef = useRef<HTMLTextAreaElement | null>(null);
	const focusOnEditRef = useRef(false);
	const copyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const drag = useRef<{ x: number; width: number } | null>(null);
	// transitions gated on mount: no slide-in flash on page load
	useEffect(() => setMounted(true), []);
	useEffect(() => () => clearTimeout(copyTimerRef.current), []);

	useEffect(() => {
		if (!controller) return;
		const event = kbdEventForAction("toggle-notes");
		const onToggle = () => controller.setOpen(!controller.getSnapshot().visible);
		window.addEventListener(event, onToggle);
		return () => window.removeEventListener(event, onToggle);
	}, [controller]);

	useEffect(() => {
		if (!preview && focusOnEditRef.current) {
			focusOnEditRef.current = false;
			editorRef.current?.focus();
		}
	}, [preview]);

	const switchToEdit = useCallback(() => {
		focusOnEditRef.current = true;
		setPreview(false);
	}, []);

	if (!controller) return null;
	const width = dragWidth ?? savedWidth;
	const hasNotes = text.trim().length > 0;
	const onErrorClick = () => void controller.flush();
	const onCopy = async () => {
		const content = controller.text();
		if (!content.trim()) return;
		const ok = await copyNotesText(content);
		if (!ok) return;
		setCopied(true);
		clearTimeout(copyTimerRef.current);
		copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
	};
	const onDownload = () => {
		const content = controller.text();
		if (!content.trim()) return;
		downloadFile(notesExportFilename(title, panelRef.current), content, "text/markdown;charset=utf-8");
	};
	return (
		<aside
			ref={panelRef}
			data-testid="notes-panel"
			data-state={visible ? "open" : "folded"}
			aria-hidden={!visible}
			inert={!visible}
			style={{ width: visible ? width : 0 }}
			className={`relative shrink-0 overflow-hidden ${mounted && dragWidth === null ? "transition-[width] duration-200" : ""}`}
		>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize notes"
				aria-valuenow={width}
				aria-valuemin={NOTES_MIN_WIDTH}
				aria-valuemax={NOTES_MAX_WIDTH}
				tabIndex={0}
				className="lh-no-drag absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize touch-none hover:bg-border focus-visible:bg-border"
				onPointerDown={(e) => {
					e.currentTarget.setPointerCapture(e.pointerId);
					drag.current = { x: e.clientX, width };
				}}
				onPointerMove={(e) => {
					if (drag.current) setDragWidth(clampNotesWidth(drag.current.width + drag.current.x - e.clientX));
				}}
				onPointerUp={(e) => {
					if (!drag.current) return;
					controller.setWidth(drag.current.width + drag.current.x - e.clientX);
					drag.current = null;
					setDragWidth(null);
				}}
				onPointerCancel={() => {
					drag.current = null;
					setDragWidth(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowLeft") { e.preventDefault(); controller.setWidth(width + 16); }
					else if (e.key === "ArrowRight") { e.preventDefault(); controller.setWidth(width - 16); }
				}}
				onDoubleClick={() => controller.setWidth(NOTES_DEFAULT_WIDTH)}
			/>
			<div className="flex h-full flex-col border-l bg-background" style={{ width }}>
				<div className="lh-drag lh-wco-gutter flex h-15 shrink-0 select-none items-center gap-1.5 border-b border-border px-3">
					<span className="min-w-0 flex-1 truncate text-sm font-medium">Notes</span>
					{saveError && (
						<button type="button" role="status" data-testid="notes-save-error" onClick={onErrorClick} className="lh-no-drag shrink truncate text-xs text-destructive hover:underline">
							{saveError}
						</button>
					)}
					<Hint label={preview ? "Switch to edit" : "Preview markdown"} side="bottom">
						<Button
							type="button"
							variant="ghost"
							size="xs"
							data-testid="notes-preview-toggle"
							aria-pressed={preview}
							aria-label={preview ? "Switch to edit" : "Preview markdown"}
							onClick={(e) => {
								blurAfterPointerClick(e);
								setPreview((v) => !v);
							}}
							className="lh-no-drag text-muted-foreground hover:text-foreground"
						>
							{preview ? <PencilIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
							<span>{preview ? "Edit" : "Preview"}</span>
						</Button>
					</Hint>
					<Hint label={copied ? "Copied" : "Copy notes"} side="bottom">
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							data-testid="notes-copy"
							aria-label="Copy notes"
							disabled={!hasNotes}
							onClick={(e) => {
								blurAfterPointerClick(e);
								void onCopy();
							}}
							className="lh-no-drag text-muted-foreground hover:text-foreground"
						>
							{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
						</Button>
					</Hint>
					<Hint label="Download notes (.md)" side="bottom">
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							data-testid="notes-download"
							aria-label="Download notes as Markdown"
							disabled={!hasNotes}
							onClick={(e) => {
								blurAfterPointerClick(e);
								onDownload();
							}}
							className="lh-no-drag text-muted-foreground hover:text-foreground"
						>
							<DownloadIcon className="size-3.5" />
						</Button>
					</Hint>
					<Hint label="Fold notes" action="toggle-notes" side="bottom">
						<Button variant="ghost" size="icon-sm" aria-label="Fold notes" onClick={() => controller.setOpen(false)} className="lh-no-drag">
							<PanelRightCloseIcon className="size-4" />
						</Button>
					</Hint>
				</div>
				{preview && (
					<div
						data-testid="notes-preview"
						onDoubleClick={switchToEdit}
						className="min-h-0 flex-1 overflow-y-auto px-3 py-2 lh-prose text-sm"
					>
						{hasNotes ? (
							<AssistantTextResponse mode="static" className="h-auto">
								{text}
							</AssistantTextResponse>
						) : (
							<p className="text-muted-foreground">No notes yet. Switch to Edit to start writing.</p>
						)}
					</div>
				)}
				<NotesEditor controller={controller} hidden={preview} textareaRef={editorRef} />
			</div>
		</aside>
	);
}

export function NotesChip() {
	const controller = useNotesController();
	const { visible } = useNotesSnapshot();
	return (
		<Hint label={visible ? "Fold notes" : "Open notes"} action="toggle-notes" side="bottom">
			<button
				type="button"
				data-testid="notes-chip"
				aria-pressed={visible}
				onClick={(e) => {
					blurAfterPointerClick(e);
					controller?.setOpen(!visible);
				}}
				className="lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border/80 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground transition-colors hover:border-border hover:text-foreground"
			>
				<NotebookPenIcon className="size-3.5 text-primary" aria-hidden />
				Notes
			</button>
		</Hint>
	);
}
