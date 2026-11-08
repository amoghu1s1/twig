import * as crypto from "node:crypto";
import * as path from "node:path";
import {
	ATTACHMENT_MAX_BYTES,
	ATTACHMENT_TYPES,
	attachmentExtension,
	type AttachmentRecord,
	type ChatRecord,
} from "../core/contracts.ts";
import { checkImageDimensions, inspectImageBytes } from "../core/images.ts";
import { epubInfo } from "../agent/subagents/epub-ops.ts";
import { pdfInfo } from "../agent/subagents/pdf-ops.ts";
import type { SessionAttachment } from "../agent/tools/attachments.ts";
import { attachmentsRoot, blobPath, pinBlob, readBlob, removeBlobsUnreferenced, unpinBlob, writeBlob } from "../store/attachments.ts";
import { stores } from "./stores.ts";

/**
 * Session context attachments — the upload orchestration behind
 * POST /api/chats/[id]/attachments. The file is validated (type, size),
 * stored as a content-addressed blob (the same bytes attached twice — any
 * sessions — are kept once), and INSPECTED once (PDF page count, EPUB
 * chapters + title — which also refuses DRM, broken files and zip bombs at
 * the door, never mid-lesson); only then does its record land on the chat.
 * One file per call.
 */

export interface UploadedFile {
	name: string;
	bytes: Uint8Array;
}

/** The outcome of one upload: the stored (or reactivated) record, or a learner-readable refusal. */
export type AttachmentUploadResult = { ok: true; attachment: AttachmentRecord } | { ok: false; error: string };

function formatMb(bytes: number): string {
	return `${Math.round(bytes / (1024 * 1024))} MB`;
}

async function inspect(filePath: string, kind: AttachmentRecord["kind"]): Promise<Partial<AttachmentRecord>> {
	if (kind === "pdf") {
		const info = await pdfInfo(filePath).catch(() => {
			throw new Error("This PDF can't be opened (damaged or password-protected).");
		});
		return { pages: info.page_count };
	}
	if (kind === "epub") {
		const info = await epubInfo(filePath);
		return { chapters: info.chapters.length, title: info.title };
	}
	return {};
}

/** Validate, store, inspect and record one file on the chat. The same bytes
 *  already on the chat return that record (restored if it was removed)
 *  instead of a duplicate. */
export async function addChatAttachment(chatId: string, upload: UploadedFile): Promise<AttachmentUploadResult> {
	const { name, bytes } = upload;
	const ext = attachmentExtension(name);
	const type = ATTACHMENT_TYPES[ext];
	if (!type) return { ok: false, error: "Unsupported file type. Attach images (PNG, JPG, GIF, WebP), PDFs, or EPUBs." };
	if (bytes.byteLength > ATTACHMENT_MAX_BYTES) return { ok: false, error: `File is larger than ${formatMb(ATTACHMENT_MAX_BYTES)}.` };
	// Images are sniffed by content before anything is stored: a renamed
	// non-image is refused, and header dimensions are bounded before any
	// decoder runs.
	if (type.kind === "image") {
		const info = inspectImageBytes(bytes);
		if (!info || info.mimeType !== type.mimeType) return { ok: false, error: "That file is not the image it claims to be." };
		try {
			checkImageDimensions(info.width, info.height);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
	const file = writeBlob(bytes, ext);
	// Already on this chat (same bytes, same type): hand back that record
	// instead of a second manifest line — restored if it was removed, so the
	// composer never sends an id the agent ignores.
	const existing = stores.chatStore.getChat(chatId)?.attachments?.find((a) => a.file === file);
	if (existing) {
		if (existing.detachedAt) return { ok: true, attachment: stores.chatStore.setAttachmentDetached(chatId, existing.id, false) ?? existing };
		return { ok: true, attachment: existing };
	}
	pinBlob(file);
	try {
		let facts: Partial<AttachmentRecord>;
		try {
			facts = await inspect(blobPath(file), type.kind);
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
		const attachment: AttachmentRecord = {
			id: `att_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
			name,
			kind: type.kind,
			mimeType: type.mimeType,
			bytes: bytes.byteLength,
			file,
			addedAt: new Date().toISOString(),
			...facts,
		};
		stores.chatStore.addAttachments(chatId, [attachment]);
		return { ok: true, attachment };
	} finally {
		unpinBlob(file);
		// A refused file's blob goes (or the new one, if the chat vanished
		// mid-upload) — unless some chat already holds the same bytes.
		removeBlobsUnreferenced([file], stores.chatStore.referencedAttachmentFiles());
	}
}

/** The session's ACTIVE attachments as the agent layer sees them; the one
 *  place blob paths are resolved. */
export function sessionAttachments(record: Pick<ChatRecord, "attachments">): SessionAttachment[] {
	return (record.attachments ?? [])
		.filter((r) => !r.detachedAt)
		.map((r) => ({ record: r, path: path.join(attachmentsRoot(), r.file) }));
}

const COMPOSER_IMAGE_EXT: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Store a wire image payload through the SAME content-addressed store the
 *  composer's upload route uses, returning the attachment ids a text event
 *  should name. The chat record thus never carries image base64. */
export async function attachComposerImages(
	chatId: string,
	images: readonly { mimeType: string; data: string }[],
): Promise<string[]> {
	const ids: string[] = [];
	for (const image of images) {
		const ext = COMPOSER_IMAGE_EXT[image.mimeType] ?? "png";
		const result = await addChatAttachment(chatId, {
			name: `pasted-image.${ext}`,
			bytes: new Uint8Array(Buffer.from(image.data, "base64")),
		});
		if (!result.ok) throw new Error(result.error);
		ids.push(result.attachment.id);
	}
	return [...new Set(ids)];
}

/** One stored attachment's bytes + MIME type, scoped to a session that
 *  holds the record — the blob preview route's read seam. */
export function readChatAttachment(chatId: string, attachmentId: string): { record: AttachmentRecord; bytes: Buffer } | null {
	const record = stores.chatStore.getChat(chatId)?.attachments?.find((a) => a.id === attachmentId);
	if (!record) return null;
	try {
		return { record, bytes: readBlob(record.file) };
	} catch {
		return null;
	}
}
