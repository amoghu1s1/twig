/**
 * Per-session persistent text highlights (ChatRecord.highlights).
 *
 * GET    → { highlights }
 * POST   → { sourceKind, sourceId, sideMessageId?, selector, color } → 201 { highlight }
 * PATCH  → { highlightId, color } → 200 { highlight }
 * DELETE → ?highlightId=... (or JSON { highlightId }) → 200 { ok: true }
 */
import { HighlightInputError, parseHighlightCreate, parseHighlightUpdate } from "@/src/core";
import { addChatHighlight, deleteChatHighlight, readChatHighlights, updateChatHighlightColor } from "@/src/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx): Promise<Response> {
	const highlights = readChatHighlights((await params).id);
	if (highlights === null) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json({ highlights });
}

export async function POST(req: Request, { params }: Ctx): Promise<Response> {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	let parsed;
	try {
		parsed = parseHighlightCreate(body);
	} catch (err) {
		if (err instanceof HighlightInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const highlight = addChatHighlight(id, parsed);
	if (!highlight) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json({ highlight }, { status: 201 });
}

export async function PATCH(req: Request, { params }: Ctx): Promise<Response> {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	let parsed;
	try {
		parsed = parseHighlightUpdate(body);
	} catch (err) {
		if (err instanceof HighlightInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const result = updateChatHighlightColor(id, parsed.highlightId, parsed.color);
	if (result === "unknown-chat") return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (result === "unknown-highlight") return Response.json({ error: "Unknown highlight" }, { status: 404 });
	return Response.json({ highlight: result });
}

export async function DELETE(req: Request, { params }: Ctx): Promise<Response> {
	const { id } = await params;
	const urlId = new URL(req.url).searchParams.get("highlightId")?.trim();
	let highlightId = urlId || "";
	if (!highlightId) {
		const body = (await req.json().catch(() => null)) as { highlightId?: unknown } | null;
		if (typeof body?.highlightId === "string") highlightId = body.highlightId.trim();
	}
	if (!highlightId) return Response.json({ error: "highlightId is required" }, { status: 400 });
	const result = deleteChatHighlight(id, highlightId);
	if (result === "unknown-chat") return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (result === "unknown-highlight") return Response.json({ error: "Unknown highlight" }, { status: 404 });
	return Response.json({ ok: true });
}
