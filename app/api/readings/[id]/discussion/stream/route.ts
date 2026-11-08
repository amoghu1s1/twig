/**
 * GET /api/readings/[id]/discussion/stream?exchange=… — one answer's live
 * tokens (docs/readings.md §14): SSE frames {type:"view", status, text,
 * activity}, then {type:"settled"} and close. The plumbing lives in the
 * server seam (discussionAnswerResponse); the route stays a thin wrapper.
 */
import { discussionAnswerResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const exchange = new URL(req.url).searchParams.get("exchange") ?? "";
	if (!/^[A-Za-z0-9_-]+$/.test(exchange)) return Response.json({ error: "exchange is required" }, { status: 400 });
	return discussionAnswerResponse(exchange);
}
