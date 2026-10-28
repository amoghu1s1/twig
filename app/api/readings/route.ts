/**
 * /api/readings — opt-in companion documents (docs/readings.md).
 *
 * GET  ?chatId=… | ?nodeId=… | (none) → { readings: ReadingSummary[] }
 *      Scoped views hide superseded versions; the library lists all.
 * POST ReadingRequest → 202 { id } — the writer runs in the background
 *      (progress on the events channel: readings-changed, activity-changed).
 *      400 bad request / unresolvable anchor; 404 unknown session or
 *      re-run source; 503 the writer's model or provider key is missing.
 */
import { parseReadingRequest } from "@/src/core";
import { createReading, listReadings, ReadingRequestError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const url = new URL(req.url);
	const chatId = url.searchParams.get("chatId") ?? undefined;
	const nodeId = url.searchParams.get("nodeId") ?? undefined;
	return Response.json({ readings: listReadings({ chatId, nodeId }) });
}

export async function POST(req: Request) {
	const body = await req.json().catch(() => null);
	const parsed = parseReadingRequest(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	try {
		const record = createReading(parsed.value);
		return Response.json({ id: record.id }, { status: 202 });
	} catch (err) {
		if (err instanceof ReadingRequestError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
