"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import {
	checkImageDimensions,
	checkSourceImageMeta,
	ImageInputError,
	inspectImageBytes,
	IMAGE_ERRORS,
	imageUrl,
	MAX_IMAGE_BYTES,
	MAX_IMAGE_DIMENSION,
	parseComposerImages,
	type DraftImage,
} from "@/src/core";
import { uploadAttachment } from "@/components/attachments";
import type { AttachmentRecord } from "@/src/core";

/** Shared draft controller with serial decoding and stale-read cancellation.
 * Normalized browser bytes are uploaded through the content-addressed
 * session-attachment store; the chat record never holds image base64. */

/** What a composer needs to show and edit the draft: one object, so the
 *  surfaces pass the draft through as a unit. */
export interface ImageDraftProps {
	images: readonly DraftImage[];
	/** Drafted images, or ones still being read (see useImageDraft). */
	hasImages: boolean;
	error: string | null;
	onChange: (next: DraftImage[]) => void;
	/** Files from a paste, the picker or a drop: all take this one door. */
	onPaste: (files: File[]) => void;
	/** Show a picture full size (its data URL or a scoped attachment URL). */
	onOpen?: (url: string) => void;
}

// ── normalization ───────────────────────────────────────────────────────────

export interface DecodedRaster {
	width: number;
	height: number;
	/** Draw the first frame at `scale` and encode it as a PNG. */
	encodePng(scale: number): Promise<Blob>;
	close(): void;
}

export interface RasterDeps {
	/** The file's leading bytes (header inspection, before any decode). */
	head(file: File): Promise<Uint8Array>;
	decode(file: File): Promise<DecodedRaster>;
	toBase64(blob: Blob): Promise<string>;
}

function readBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result ?? "");
			const comma = url.indexOf(",");
			if (comma < 0) reject(new Error("empty"));
			else resolve(url.slice(comma + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error("read"));
		reader.readAsDataURL(blob);
	});
}

async function decodeInBrowser(file: File): Promise<DecodedRaster> {
	let source: CanvasImageSource;
	let width: number;
	let height: number;
	let release = () => {};
	if (typeof createImageBitmap === "function") {
		// An animated GIF/WebP decodes to its first frame.
		const bitmap = await createImageBitmap(file);
		source = bitmap;
		width = bitmap.width;
		height = bitmap.height;
		release = () => bitmap.close();
	} else {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.src = url;
		await img.decode();
		source = img;
		width = img.naturalWidth;
		height = img.naturalHeight;
		release = () => URL.revokeObjectURL(url);
	}
	return {
		width,
		height,
		close: release,
		encodePng(scale) {
			const canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(width * scale));
			canvas.height = Math.max(1, Math.round(height * scale));
			const ctx = canvas.getContext("2d");
			if (!ctx) return Promise.reject(new Error("canvas"));
			ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
			return new Promise((resolve, reject) =>
				canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode"))), "image/png"),
			);
		},
	};
}

async function headOf(file: File): Promise<Uint8Array> {
	return new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
}

export const browserRaster: RasterDeps = { head: headOf, decode: decodeInBrowser, toBase64: readBase64 };

/** One source file → the {mimeType, data} the draft (and the upload) carries. */
export async function normalizeImageFile(file: File, deps: RasterDeps = browserRaster): Promise<{ mimeType: string; data: string }> {
	checkSourceImageMeta(file.type, file.size); // type + 20 MiB, before any decode
	// Strict header inspection (core): real format and bounded dimensions
	// BEFORE the browser is asked to decode anything.
	const info = inspectImageBytes(await deps.head(file).catch(() => new Uint8Array()));
	if (!info || info.mimeType !== file.type) throw new ImageInputError(IMAGE_ERRORS.content);
	checkImageDimensions(info.width, info.height);
	let raster: DecodedRaster;
	try {
		raster = await deps.decode(file);
	} catch {
		throw new ImageInputError(IMAGE_ERRORS.unreadable);
	}
	try {
		const { width, height } = raster;
		checkImageDimensions(width, height);
		const longest = Math.max(width, height);
		const keepsBytes = (file.type === "image/png" || file.type === "image/jpeg") && file.size <= MAX_IMAGE_BYTES && longest <= MAX_IMAGE_DIMENSION;
		if (keepsBytes) return { mimeType: file.type, data: await deps.toBase64(file) };
		let scale = Math.min(1, MAX_IMAGE_DIMENSION / longest);
		for (let attempt = 0; attempt < 6; attempt++, scale *= 0.75) {
			const png = await raster.encodePng(scale);
			if (png.size <= MAX_IMAGE_BYTES) return { mimeType: "image/png", data: await deps.toBase64(png) };
		}
		throw new ImageInputError(IMAGE_ERRORS.size);
	} catch (err) {
		throw err instanceof ImageInputError ? err : new ImageInputError(IMAGE_ERRORS.unreadable);
	} finally {
		raster.close();
	}
}

// ── upload ──────────────────────────────────────────────────────────────────

const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

function base64ToBlob(mimeType: string, data: string): Blob {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new Blob([bytes], { type: mimeType });
}

/** A drafted image as a File for the attachment upload route. */
export function draftImageFile(image: DraftImage): File {
	const ext = MIME_EXT[image.mimeType] ?? "png";
	return new File([base64ToBlob(image.mimeType, image.data)], `pasted-image.${ext}`, { type: image.mimeType });
}

// ── the controller ──────────────────────────────────────────────────────────

export interface ImageDraftState {
	images: readonly DraftImage[];
	reading: number;
	error: string | null;
}

/** A draft image plus the server attachment it became. */
export interface UploadedDraftImage {
	image: DraftImage;
	record: AttachmentRecord;
}

export class ImageDraftController {
	images: DraftImage[] = [];
	/** draft image id → its uploaded attachment id. */
	uploaded = new Map<string, string>();
	records = new Map<string, AttachmentRecord>();
	private reading = 0;
	private error: string | null = null;
	private epoch = 0;
	private disposed = false;
	private queue: Promise<void> = Promise.resolve();
	private listeners = new Set<() => void>();
	private snap: ImageDraftState = { images: [], reading: 0, error: null };

	constructor(private readonly normalize: (file: File) => Promise<{ mimeType: string; data: string }> = normalizeImageFile) {}

	subscribe = (fn: () => void): (() => void) => {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	};
	getState = (): ImageDraftState => this.snap;

	private emit(): void {
		this.snap = { images: this.images, reading: this.reading, error: this.error };
		for (const fn of this.listeners) fn();
	}

	setError = (message: string | null): void => {
		if (this.disposed) return;
		this.error = message;
		this.emit();
	};

	/** Replace the drafted images (remove a thumbnail, programmatic edit). */
	setImages = (next: DraftImage[]): void => {
		if (this.disposed) return;
		this.images = next;
		this.emit();
	};

	/** Empty the draft (a send took it): pending reads are invalidated. */
	clear = (): void => {
		this.epoch++;
		this.reading = 0;
		this.images = [];
		this.uploaded.clear();
		this.records.clear();
		this.error = null;
		if (!this.disposed) this.emit();
	};

	/** Unmount: no late decode may touch state or resurrect anything. */
	dispose = (): void => {
		this.epoch++;
		this.disposed = true;
	};

	/** Strict-mode remount: the same instance is re-armed. */
	revive = (): void => {
		this.disposed = false;
	};

	/** Drop exactly these images (an ACKed send), keeping any added since. */
	removeImages = (ids: readonly string[]): void => {
		const gone = new Set(ids);
		for (const id of gone) {
			this.uploaded.delete(id);
			this.records.delete(id);
		}
		this.setImages(this.images.filter((i) => !gone.has(i.id)));
	};

	/** Put a refused send's images back WITHOUT dropping later ones. */
	restoreSent = (sent: readonly DraftImage[]): void => {
		const ids = new Set(sent.map((i) => i.id));
		this.setImages([...sent, ...this.images.filter((i) => !ids.has(i.id))]);
	};

	addFiles = (files: readonly File[]): void => {
		if (this.disposed || files.length === 0) return;
		this.error = null;
		const epoch = this.epoch;
		this.reading += files.length;
		this.emit();
		const batch = [...files];
		this.queue = this.queue.then(async () => {
			for (const file of batch) {
				if (epoch !== this.epoch) return; // cleared or unmounted: stale
				let failure: string | null = null;
				let added: DraftImage | null = null;
				try {
					const { mimeType, data } = await this.normalize(file);
					if (epoch !== this.epoch) return;
					const candidate: DraftImage = { id: `img_${crypto.randomUUID()}`, type: "image", mimeType, data };
					// The server's own rules: count, sizes, real format.
					parseComposerImages([...this.images, candidate]);
					added = candidate;
				} catch (err) {
					if (epoch !== this.epoch) return;
					failure = err instanceof ImageInputError ? err.message : IMAGE_ERRORS.unreadable;
				}
				this.reading = Math.max(0, this.reading - 1);
				if (added) this.images = [...this.images, added];
				if (failure) this.error = failure;
				this.emit();
			}
		});
	};

	/** Upload every drafted image that isn't on the server yet. Returns the
	 *  attachment ids in draft order; the records ride along for the session
	 *  files panel. */
	upload = async (chatId: string, fetchLike: typeof fetch = fetch): Promise<UploadedDraftImage[]> => {
		this.setError(null);
		const out: UploadedDraftImage[] = [];
		for (const image of this.images) {
			const existing = this.uploaded.get(image.id);
			if (existing) {
				const record = this.records.get(image.id);
				if (record) out.push({ image, record });
				continue;
			}
			try {
				const record = await uploadAttachment(chatId, draftImageFile(image), fetchLike);
				this.uploaded.set(image.id, record.id);
				this.records.set(image.id, record);
				out.push({ image, record });
			} catch (err) {
				this.setError(err instanceof Error ? err.message : String(err));
				throw err;
			}
		}
		return out;
	};

	/** Await the reads already in flight (a send never races a paste). */
	awaitReads = async (): Promise<void> => {
		await this.queue;
	};
}

export function useImageDraft() {
	const ref = useRef<ImageDraftController | null>(null);
	if (!ref.current) ref.current = new ImageDraftController();
	const c = ref.current;
	useEffect(() => {
		c.revive();
		const paste = (event: ClipboardEvent) => {
			if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
			const target = event.target instanceof Element ? event.target : null;
			if (imagePasteAllowed(target, document.activeElement)) handleImagePaste(event, c.addFiles);
		};
		document.addEventListener("paste", paste);
		return () => { document.removeEventListener("paste", paste); c.dispose(); };
	}, [c]);
	const state = useSyncExternalStore(c.subscribe, c.getState, c.getState);
	// Live mirror: a send resuming after an await reads the draft, not a closure.
	const imagesRef = useMemo(
		() => ({
			get current() {
				return c.images;
			},
		}),
		[c],
	);
	const hasImages = state.images.length > 0 || state.reading > 0;
	const props = useMemo<Omit<ImageDraftProps, "onOpen">>(
		() => ({ images: state.images, hasImages, error: state.error, onChange: c.setImages, onPaste: c.addFiles }),
		[state, hasImages, c],
	);
	return {
		imagesRef,
		hasImages,
		setError: c.setError,
		restoreSent: c.restoreSent,
		removeImages: c.removeImages,
		awaitReads: c.awaitReads,
		upload: c.upload,
		clear: c.clear,
		props,
		preview: (image: DraftImage) => imageUrl(image),
	};
}

// ── DOM handlers ────────────────────────────────────────────────────────────

/** Other editors own their paste; non-editable page/composer controls do not. */
export function imagePasteAllowed(target: Element | null, active: Element | null): boolean {
	const blocked = (element: Element | null) => {
		if (element?.closest('[role="dialog"], [role="alertdialog"]')) return true;
		const field = element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
		return !!field && !field.closest("[data-image-composer]");
	};
	return !blocked(target) && !blocked(active);
}

type ImagePasteEvent = Pick<ClipboardEvent, "clipboardData" | "preventDefault" | "defaultPrevented"> & { nativeEvent?: object };
const handledImagePastes = new WeakSet<object>();

/** Textarea and page listeners share one claim, including mixed text/image pastes. */
export function handleImagePaste(e: ImagePasteEvent, onPaste: ((files: File[]) => void) | undefined): boolean {
	const native = e.nativeEvent ?? e;
	if (!onPaste || e.defaultPrevented || handledImagePastes.has(native)) return false;
	const data = e.clipboardData;
	const files = clipboardImageFiles(data);
	if (files.length === 0) return false;
	handledImagePastes.add(native);
	if (!data || data.getData("text/plain").length === 0) e.preventDefault();
	onPaste(files);
	return true;
}

export function clipboardImageFiles(data: DataTransfer | null): File[] {
	if (!data) return [];
	const fromFiles = Array.from(data.files ?? []).filter((f) => f.type.startsWith("image/"));
	if (fromFiles.length > 0) return fromFiles;
	return Array.from(data.items ?? [])
		.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
		.map((item) => item.getAsFile())
		.filter((f): f is File => f !== null);
}

function hasFiles(data: DataTransfer | null): boolean {
	return Array.from(data?.types ?? []).includes("Files");
}

/** Drag-over / drop handlers for a composer. With `imagesOnly`, only image
 *  files are claimed (other drops keep flowing to the desktop path zone).
 *  EVERY claimed file drop is prevented from navigating the app away. */
export function imageDropHandlers(
	onFiles: ((files: File[]) => void) | undefined,
	opts: { imagesOnly?: boolean } = {},
) {
	const claimed = (data: DataTransfer) => {
		if (!hasFiles(data)) return null;
		const files = Array.from(data.files ?? []);
		if (!opts.imagesOnly) return files;
		const images = files.filter((f) => f.type.startsWith("image/"));
		return images.length > 0 ? images : null;
	};
	return {
		onDragOver(e: ReactDragEvent) {
			// Any file drag is ours to keep from navigating; the drop filters.
			if (hasFiles(e.dataTransfer)) e.preventDefault();
		},
		onDrop(e: ReactDragEvent) {
			const files = claimed(e.dataTransfer);
			if (!files) return;
			e.preventDefault();
			e.stopPropagation();
			if (files.length > 0) onFiles?.(files);
		},
	};
}

export type { AttachmentRecord };
