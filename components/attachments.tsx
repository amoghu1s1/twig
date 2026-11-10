"use client";

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { FilePlus2Icon, FolderOpenIcon, Loader2Icon, PaperclipIcon, UploadIcon, XIcon } from "lucide-react";
import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_TYPES,
	attachmentExtension,
	directoryReferencePath,
	quoteFilePath,
	type AttachmentRecord,
} from "@/src/core";
import { Hint } from "@/components/ui/hint";
import { BROWSER_NOTICE } from "@/components/file-path-drop-zone";
import { INSERT_FILE_PATHS_EVENT } from "@/components/path-input";
import type { ImageDraftProps } from "@/components/draft-images";

/**
 * Session context attachments — the client side. ONE control ("Add context")
 * is the app's only add-context entry point: it uploads session files
 * (images, PDFs, EPUBs), carries picked images in the draft strip, inserts
 * local file/folder references, and lists/removes/restores an existing
 * session's files. Picked docs wait as chips in the composer and upload ON
 * SEND, one file per request (the API proxy buffers one ATTACHMENT_MAX_BYTES
 * body). In a live session they upload straight to the session, so file
 * management works even while a question or problem owns the composer.
 */

export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).join(",");

/** Picked files → the rooted paths an editor chips, via the desktop bridge.
 *  Same validity rule as drops: a file without a usable path is skipped,
 *  never guessed. */
export function pathsForFiles(files: Iterable<File>, resolve: (file: File) => string): { paths: string[]; skipped: number } {
	const paths: string[] = [];
	let skipped = 0;
	for (const file of files) {
		try {
			const path = resolve(file);
			quoteFilePath(path);
			paths.push(path);
		} catch { skipped++; }
	}
	return { paths, skipped };
}

/** The scoped preview URL for one stored attachment (images, PDFs). */
export function attachmentContentUrl(chatId: string, attachmentId: string): string {
	return `/api/chats/${encodeURIComponent(chatId)}/attachments/${encodeURIComponent(attachmentId)}/content`;
}

interface DraftFile {
	key: string;
	file: File;
	/** Set once the file is on the server. */
	id?: string;
}

/** Upload one file to the chat; the stored record, or a thrown Error
 *  carrying a learner-readable reason. */
export async function uploadAttachment(chatId: string, file: File, fetchLike: typeof fetch): Promise<AttachmentRecord> {
	const form = new FormData();
	form.append("file", file);
	const res = await fetchLike(`/api/chats/${chatId}/attachments`, { method: "POST", body: form });
	const body = (await res.json().catch(() => null)) as { attachment?: AttachmentRecord; error?: string } | null;
	if (!res.ok || !body?.attachment) throw new Error(`${file.name}: ${body?.error ?? `upload failed (HTTP ${res.status})`}`);
	return body.attachment;
}

/** Client-side precheck — the server validates again. */
export function precheck(file: File): string | null {
	if (!ATTACHMENT_TYPES[attachmentExtension(file.name)]) return `${file.name}: unsupported type. Attach images, PDFs, or EPUBs.`;
	if (file.size > ATTACHMENT_MAX_BYTES) return `${file.name}: larger than 50 MB.`;
	return null;
}

/** Upsert by id: a record with a known id replaces it in place, new ones append in order. */
export function mergeAttachments(prev: readonly AttachmentRecord[], records: readonly AttachmentRecord[]): AttachmentRecord[] {
	const next = [...prev];
	for (const record of records) {
		const index = next.findIndex((a) => a.id === record.id);
		if (index === -1) next.push(record);
		else next[index] = record;
	}
	return next;
}

/** A learner-facing size: KB under 1 MiB, else MB to one decimal ("820 KB", "4.2 MB"). */
export function formatFileSize(bytes: number): string {
	if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	return `${(bytes / 1048576).toFixed(1)} MB`;
}

/** One line of structure facts for a file ("PDF · 3 pages · 120 KB"). */
export function attachmentFacts(a: AttachmentRecord): string {
	const size = formatFileSize(a.bytes);
	if (a.kind === "pdf") return `PDF · ${a.pages ?? "?"} pages · ${size}`;
	if (a.kind === "epub") return `EPUB · ${a.chapters ?? "?"} chapters · ${size}`;
	return `Image · ${size}`;
}

export interface AttachmentDraft {
	files: readonly DraftFile[];
	error: string | null;
	add(list: FileList | readonly File[] | null): void;
	remove(key: string): void;
	clear(): void;
	/** Upload every pending file to the chat (in order); the ids of all
	 *  draft files. Throws on the first failure — earlier uploads keep their
	 *  ids for the retry. */
	upload(chatId: string, fetchLike?: typeof fetch): Promise<string[]>;
	/** A stable fingerprint of the picked set (retry identity). */
	identity(): string;
}

export function useAttachmentDraft(onUploaded?: (records: AttachmentRecord[]) => void): AttachmentDraft {
	const [files, setFiles] = useState<DraftFile[]>([]);
	const [error, setError] = useState<string | null>(null);
	// The mirror: upload() runs across renders and must see every id it set.
	const filesRef = useRef<DraftFile[]>([]);
	const write = (next: DraftFile[]) => {
		filesRef.current = next;
		setFiles(next);
	};
	return {
		files,
		error,
		add(list) {
			if (!list) return;
			const problems: string[] = [];
			const added: DraftFile[] = [];
			for (const file of Array.from(list)) {
				const problem = precheck(file);
				if (problem) problems.push(problem);
				else added.push({ key: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`, file });
			}
			setError(problems.length ? problems.join("\n") : null);
			write([...filesRef.current, ...added]);
		},
		remove(key) {
			write(filesRef.current.filter((f) => f.key !== key));
			setError(null);
		},
		clear() {
			write([]);
			setError(null);
		},
		async upload(chatId, fetchLike = fetch) {
			setError(null);
			const uploaded: AttachmentRecord[] = [];
			try {
				for (const entry of filesRef.current) {
					if (entry.id) continue;
					const record = await uploadAttachment(chatId, entry.file, fetchLike);
					uploaded.push(record);
					write(filesRef.current.map((f) => (f.key === entry.key ? { ...f, id: record.id } : f)));
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				throw err;
			} finally {
				if (uploaded.length) onUploaded?.(uploaded);
			}
			return filesRef.current.map((f) => f.id!);
		},
		identity() {
			return filesRef.current.map((f) => f.key).join("|");
		},
	};
}

const REMOVE_BUTTON =
	"flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

function Chip({ name, detached, onRemove, onOpen }: { name: string; detached?: boolean; onRemove?: () => void; onOpen?: () => void }) {
	const className = "flex max-w-56 items-center gap-1 rounded-full border border-border bg-card py-1 pr-0.5 pl-2.5 font-ui text-xs text-foreground";
	const content = (
		<>
			<PaperclipIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
			<span className={detached ? "truncate line-through text-muted-foreground" : "truncate"}>{name}</span>
			{detached && <span className="text-muted-foreground">removed</span>}
			{onRemove && (
				<button type="button" aria-label={`Remove ${name}`} onClick={onRemove} className={REMOVE_BUTTON}>
					<XIcon aria-hidden="true" className="size-3.5" />
				</button>
			)}
		</>
	);
	if (onOpen) {
		return (
			<button
				type="button"
				data-testid="attachment-chip"
				onClick={onOpen}
				title={`Show ${name} in session files`}
				className={`${className} cursor-pointer hover:bg-accent`}
			>
				{content}
			</button>
		);
	}
	return (
		<span data-testid="attachment-chip" className={className}>
			{content}
		</span>
	);
}

const ADD_BUTTON =
	"flex cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border/80 bg-transparent px-3 py-1.5 font-ui text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50";

function isImageFile(file: File): boolean {
	return ATTACHMENT_TYPES[attachmentExtension(file.name)]?.kind === "image";
}

/** The app's ONE add-context entry point. A paperclip opens one popover:
 *  upload files (images join the image draft; PDFs/EPUBs join the pending
 *  chip row or the live session), reference local files/folders by path,
 *  and — in a session — list, remove and restore the session's files.
 *  Nothing here sends a message; the tutor sees changes from the next turn. */
export function ContextAttachControl({
	draft,
	disabled,
	lockRemoval = disabled,
	editorRef,
	imageDraft,
	chatId,
	attachments,
	setAttachments,
	open: controlledOpen,
	onOpenChange,
	highlightId = null,
	onUploadingChange,
	onUploaded,
	fetchLike = fetch,
}: {
	/** Creation surfaces: picked docs wait as chips and upload on send. */
	draft?: AttachmentDraft;
	/** Disables ADDING (never managing an existing session's files). */
	disabled?: boolean;
	lockRemoval?: boolean;
	/** The composer's PathInput root, for local path references. */
	editorRef?: React.RefObject<HTMLDivElement | null>;
	/** Picked images join the image draft (preview + resize + paste). */
	imageDraft?: Pick<ImageDraftProps, "onPaste">;
	/** Live session: uploads land immediately and the list is manageable. */
	chatId?: string;
	attachments?: readonly AttachmentRecord[];
	setAttachments?: Dispatch<SetStateAction<AttachmentRecord[]>>;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** The file to reveal when a transcript chip opened this popover. */
	highlightId?: string | null;
	/** The owner blocks sending while an upload is in flight (the tutor's
	 *  next turn must see the file). */
	onUploadingChange?: (uploading: boolean) => void;
	/** A live session's successful uploads — the chat rides their ids on the
	 *  next message, so the transcript records what came with it. */
	onUploaded?: (records: readonly AttachmentRecord[]) => void;
	fetchLike?: typeof fetch;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const panelRef = useRef<HTMLDivElement>(null);
	const uploadRef = useRef<HTMLInputElement>(null);
	const referenceRef = useRef<HTMLInputElement>(null);
	const [localOpen, setLocalOpen] = useState(false);
	const open = controlledOpen ?? localOpen;
	const setOpen = (next: boolean) => {
		if (onOpenChange) onOpenChange(next);
		else setLocalOpen(next);
	};
	// The outside-pointer effect must read the LATEST owner callback without
	// re-subscribing on every render.
	const setOpenRef = useRef(setOpen);
	setOpenRef.current = setOpen;
	const [notice, setNotice] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [pendingId, setPendingId] = useState<string | null>(null);
	const [uploading, setUploading] = useState<{ key: string; name: string }[]>([]);

	const active = (attachments ?? []).filter((a) => !a.detachedAt);
	const removed = (attachments ?? []).filter((a) => a.detachedAt);
	const canUpload = Boolean(draft || (chatId && setAttachments));
	const canManage = Boolean(chatId && setAttachments && attachments);
	const total = active.length + (draft?.files.length ?? 0);

	// Close on an outside pointer, and move focus into the popover on open.
	useEffect(() => {
		if (!open) return;
		const dismiss = (event: PointerEvent) => {
			if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpenRef.current(false);
		};
		document.addEventListener("pointerdown", dismiss);
		const frame = requestAnimationFrame(() => {
			const row = highlightId ? panelRef.current?.querySelector<HTMLElement>(`[data-attachment-id="${CSS.escape(highlightId)}"]`) : null;
			if (row) {
				row.scrollIntoView({ block: "nearest" });
				row.querySelector<HTMLButtonElement>("button")?.focus();
			} else {
				panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
			}
		});
		return () => {
			document.removeEventListener("pointerdown", dismiss);
			cancelAnimationFrame(frame);
		};
	}, [open, highlightId]);

	const insertPaths = (paths: readonly string[]) => {
		if (paths.length === 0) return;
		editorRef?.current?.dispatchEvent(new CustomEvent(INSERT_FILE_PATHS_EVENT, { detail: [...paths] }));
	};

	const referenceFiles = () => {
		const resolve = window.lh?.getPathForFile;
		if (!resolve) {
			setNotice(BROWSER_NOTICE);
			return;
		}
		setOpen(false);
		setNotice("");
		referenceRef.current?.click();
	};

	const referenceFolder = async () => {
		const choose = window.lh?.chooseAttachmentFolder;
		if (!choose) {
			setNotice(BROWSER_NOTICE);
			return;
		}
		setNotice("");
		try {
			const chosen = await choose();
			if (chosen === null) return; // native cancel: draft intact
			insertPaths([directoryReferencePath(chosen)]);
			setOpen(false);
		} catch {
			setError("Could not choose a folder. Try again.");
		}
	};

	const uploadToSession = async (files: readonly File[]) => {
		if (!chatId || !setAttachments || files.length === 0) return;
		const problems: string[] = [];
		const uploaded: AttachmentRecord[] = [];
		onUploadingChange?.(true);
		try {
			for (const file of files) {
				const problem = precheck(file);
				if (problem) {
					problems.push(problem);
					continue;
				}
				const key = `${file.name}:${Math.random().toString(36).slice(2)}`;
				setUploading((prev) => [...prev, { key, name: file.name }]);
				try {
					const record = await uploadAttachment(chatId, file, fetchLike);
					uploaded.push(record);
					setAttachments((prev) => mergeAttachments(prev, [record]));
				} catch (err) {
					problems.push(err instanceof Error ? err.message : String(err));
				} finally {
					setUploading((prev) => prev.filter((u) => u.key !== key));
				}
			}
		} finally {
			onUploadingChange?.(false);
		}
		if (uploaded.length > 0) onUploaded?.(uploaded);
		setError(problems.length ? problems.join("\n") : null);
	};

	const pickFiles = (list: FileList | null) => {
		const files = Array.from(list ?? []);
		if (files.length === 0) return;
		const images = imageDraft ? files.filter(isImageFile) : [];
		const docs = imageDraft ? files.filter((f) => !isImageFile(f)) : files;
		if (images.length > 0) imageDraft?.onPaste(images);
		if (docs.length === 0) return;
		if (draft) draft.add(docs);
		else void uploadToSession(docs);
	};

	const setDetached = async (a: AttachmentRecord, detached: boolean) => {
		if (!chatId || !setAttachments) return;
		setPendingId(a.id);
		try {
			const res = await fetchLike(`/api/chats/${chatId}/attachments/${a.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ detached }),
			});
			const body = (await res.json().catch(() => null)) as { attachment?: AttachmentRecord } | null;
			const record = body?.attachment;
			if (!res.ok || !record) throw new Error(`HTTP ${res.status}`);
			setAttachments((prev) => mergeAttachments(prev, [record]));
			setError(null);
		} catch {
			setError(detached ? `Couldn't remove ${a.name}. Try again.` : `Couldn't restore ${a.name}. Try again.`);
		} finally {
			setPendingId(null);
		}
	};

	const rowHighlight = (a: AttachmentRecord) => (a.id === highlightId ? "rounded-lg outline outline-1 outline-foreground/40" : "");

	return (
		<div
			ref={rootRef}
			className="relative shrink-0"
			onKeyDown={(event) => {
				if (event.key === "Tab") event.stopPropagation(); // the popover owns its keyboard walk
				if (event.key === "Escape" && open) {
					event.preventDefault();
					event.stopPropagation();
					setOpen(false);
					triggerRef.current?.focus();
				}
			}}
		>
			<input
				ref={uploadRef}
				type="file"
				multiple
				accept={ATTACHMENT_ACCEPT}
				className="hidden"
				data-testid="attachment-input"
				onChange={(e) => {
					pickFiles(e.currentTarget.files);
					e.currentTarget.value = ""; // allow re-picking the same file
				}}
			/>
			<input
				ref={referenceRef}
				type="file"
				multiple
				hidden
				data-testid="reference-files-input"
				onChange={(e) => {
					const files = Array.from(e.currentTarget.files ?? []);
					e.currentTarget.value = "";
					const resolve = window.lh?.getPathForFile;
					if (!resolve || files.length === 0) return;
					const { paths, skipped } = pathsForFiles(files, resolve);
					insertPaths(paths);
					if (skipped > 0) setError(`${skipped} file${skipped === 1 ? "" : "s"} had no available path and ${skipped === 1 ? "was" : "were"} skipped.`);
				}}
			/>
			<Hint label="Add context — files, images, or local paths">
				<button
					ref={triggerRef}
					type="button"
					data-testid="attach-context"
					aria-label="Add context"
					aria-haspopup="dialog"
					aria-expanded={open}
					onClick={() => {
						setNotice("");
						setOpen(!open);
					}}
					className={ADD_BUTTON}
				>
					<PaperclipIcon aria-hidden="true" className="size-3.5" />
					Add context
					{total > 0 && <span className="tabular-nums text-muted-foreground/80">{total}</span>}
				</button>
			</Hint>
			{open && (
				<div
					ref={panelRef}
					role="dialog"
					aria-label="Add context"
					data-testid="attachment-popover"
					className="absolute bottom-full left-0 z-50 mb-2 max-h-[min(60vh,28rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card p-2 text-xs shadow-xl"
				>
					<div className="flex flex-col gap-0.5">
						{canUpload && (
							<button
								type="button"
								data-testid="context-upload"
								disabled={disabled}
								onClick={() => {
									setNotice("");
									uploadRef.current?.click();
								}}
								className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
							>
								<UploadIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
								<span className="min-w-0 flex-1">
									Upload files
									<span className="block text-muted-foreground">Images, PDFs, EPUBs · up to 50 MB</span>
								</span>
							</button>
						)}
						<button
							type="button"
							data-testid="context-reference-files"
							disabled={disabled}
							onClick={referenceFiles}
							className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
						>
							<FilePlus2Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
							<span className="min-w-0 flex-1">
								Reference files
								<span className="block text-muted-foreground">Stays on disk; the path enters your message</span>
							</span>
						</button>
						<button
							type="button"
							data-testid="context-reference-folder"
							disabled={disabled}
							onClick={() => void referenceFolder()}
							className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
						>
							<FolderOpenIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
							<span className="min-w-0 flex-1">
								Reference folder
								<span className="block text-muted-foreground">Insert one directory path</span>
							</span>
						</button>
					</div>
					{canManage && (
						<>
							<div className="my-2 border-t border-border" />
							<div className={CAPTION}>Session files</div>
							<div className="max-h-56 overflow-y-auto">
								{active.length === 0 && removed.length === 0 && uploading.length === 0 && (
									<p className="px-1.5 text-muted-foreground">No files in this session yet.</p>
								)}
								{active.length > 0 && (
									<ul>
										{active.map((a) => (
											<li
												key={a.id}
												data-testid="session-file"
												data-attachment-id={a.id}
												data-highlighted={a.id === highlightId ? "true" : undefined}
												className={`flex items-center gap-2 px-1.5 py-1.5 ${rowHighlight(a)}`}
											>
												<div className="min-w-0 flex-1">
													<FileName name={a.name} />
													<div className="text-muted-foreground">{attachmentFacts(a)}</div>
												</div>
												<button
													type="button"
													aria-label={`Remove ${a.name}`}
													disabled={pendingId === a.id}
													onClick={() => void setDetached(a, true)}
													className={REMOVE_BUTTON}
												>
													<XIcon aria-hidden="true" className="size-3.5" />
												</button>
											</li>
										))}
									</ul>
								)}
								{uploading.length > 0 && (
									<ul>
										{uploading.map((u) => (
											<li key={u.key} data-testid="session-file-uploading" className="flex items-center gap-2 px-1.5 py-1.5 text-muted-foreground">
												<Loader2Icon aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
												<FileName name={u.name} />
											</li>
										))}
									</ul>
								)}
								{removed.length > 0 && (
									<>
										<div className={`${CAPTION} mt-3`}>Removed</div>
										<ul>
											{removed.map((a) => (
												<li
													key={a.id}
													data-testid="session-file-removed"
													data-attachment-id={a.id}
													data-highlighted={a.id === highlightId ? "true" : undefined}
													className={`flex items-center gap-2 px-1.5 py-1.5 ${rowHighlight(a)}`}
												>
													<div className="min-w-0 flex-1">
														<FileName name={a.name} removed />
														<div className="text-muted-foreground">Removed from context</div>
													</div>
													<button
														type="button"
														aria-label={`Undo removing ${a.name}`}
														disabled={pendingId === a.id}
														onClick={() => void setDetached(a, false)}
														className="cursor-pointer text-xs text-foreground underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
													>
														Undo
													</button>
												</li>
											))}
										</ul>
									</>
								)}
							</div>
							<p className="mt-2 px-1.5 text-muted-foreground">The tutor sees changes from your next message.</p>
						</>
					)}
					{notice && (
						<p role="status" className="mt-2 rounded-md bg-accent px-2 py-1.5 text-muted-foreground">
							{notice}
						</p>
					)}
					{error && (
						<p role="alert" className="mt-2 whitespace-pre-wrap break-words px-1.5 text-destructive">
							{error}
						</p>
					)}
				</div>
			)}
			{draft?.files.map((f) => (
				<Chip key={f.key} name={f.file.name} onRemove={lockRemoval ? undefined : () => draft.remove(f.key)} />
			))}
			{draft?.error && (
				<p role="alert" className="w-full whitespace-pre-wrap break-words text-xs text-destructive">
					{draft.error}
				</p>
			)}
		</div>
	);
}

/** The transcript's record of what rode a message — read-only; a click
 *  opens the session-files panel on that file. */
export function AttachmentChips({ items, onOpen }: { items: readonly { id: string; name: string; detached: boolean }[]; onOpen?: (id: string) => void }) {
	if (items.length === 0) return null;
	return (
		<div data-testid="message-attachments" className="mt-1.5 flex flex-wrap gap-1.5">
			{items.map((it, i) => (
				<Chip key={`${it.id}-${i}`} name={it.name} detached={it.detached} onOpen={onOpen ? () => onOpen(it.id) : undefined} />
			))}
		</div>
	);
}

const CAPTION = "mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground";

/** A file name that truncates in the middle of its base and keeps the extension visible. */
function FileName({ name, removed }: { name: string; removed?: boolean }) {
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	return (
		<span title={name} className={`flex min-w-0 text-sm ${removed ? "line-through text-muted-foreground" : "text-foreground"}`}>
			<span className="truncate">{base}</span>
			<span className="shrink-0">{ext}</span>
		</span>
	);
}
