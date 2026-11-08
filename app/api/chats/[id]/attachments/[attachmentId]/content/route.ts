import { getChat, readChatAttachment } from "@/src/server";

/**
 * GET /api/chats/[id]/attachments/[attachmentId]/content — the stored
 * bytes of one session attachment, scoped to the chat that holds it.
 * Content-addressed blobs are immutable, so the response is cacheable for
 * the session's life. This is the preview path images use in the
 * transcript and draft (no base64 in the chat record).
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; attachmentId: string }> }) {
	const { id, attachmentId } = await params;
	if (!getChat(id)) return new Response("Not found", { status: 404 });
	const found = readChatAttachment(id, attachmentId);
	if (!found) return new Response("Not found", { status: 404 });
	const filename = found.record.name.replace(/[^\x20-\x7e]/g, "_").replace(/[\\"]/g, "_");
	return new Response(new Uint8Array(found.bytes), {
		headers: {
			"content-type": found.record.mimeType,
			"content-length": String(found.bytes.byteLength),
			"content-disposition": `inline; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(found.record.name)}`,
			"x-content-type-options": "nosniff",
			"cache-control": "private, max-age=31536000, immutable",
		},
	});
}
