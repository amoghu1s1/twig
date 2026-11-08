/**
 * /api/readings/[id]/discussion — Discuss on a reading (docs/readings.md §14).
 *
 * GET  → the reading's discussion (side chat + passage threads; an empty
 *        one when nothing was asked), costs joined. 404 unknown reading.
 * POST DiscussionAsk → 202 { threadId, exchangeId } — the companion answers
 *      in the background; tokens on .../discussion/stream?exchange=…,
 *      record changes on the events channel (discussion-changed).
 *      400 bad ask; 404 unknown reading/thread; 409 the reading isn't
 *      ready or the thread is still answering; 503 no model or key.
 */
import { parseDiscussionAsk } from "@/src/core";
import { askDiscussion, DiscussionRequestError, getDiscussion } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const discussion = getDiscussion(id);
	if (!discussion) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(discussion);
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = await req.json().catch(() => null);
	const parsed = parseDiscussionAsk(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	try {
		return Response.json(askDiscussion(id, parsed.value), { status: 202 });
	} catch (err) {
		if (err instanceof DiscussionRequestError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
