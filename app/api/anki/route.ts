/**
 * /api/anki — the graph → Anki channel (src/server/anki-sync.ts).
 *
 *   GET                  status: is Anki reachable, how many propositions
 *                        are carded / waiting / not carded yet
 *   GET ?format=import   every carded proposition as an Anki File > Import
 *                        text file (the no-AnkiConnect fallback)
 *   POST {sourceIds?, nodeIds?}
 *                        card what is in scope (everything when both are
 *                        absent) and send every waiting card to Anki;
 *                        answers the sync result. Unconfigured or keyless
 *                        card writer = the usual 503 refusal envelope.
 */
import { ankiSync, ankiSyncErrorResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
	const format = new URL(request.url).searchParams.get("format");
	if (format === "import") {
		return new Response(ankiSync.importFile(), {
			headers: {
				"Content-Type": "text/plain; charset=utf-8",
				"Content-Disposition": 'attachment; filename="learnharness-anki.txt"',
			},
		});
	}
	return Response.json(await ankiSync.status());
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

export async function POST(request: Request) {
	let body: unknown = {};
	try {
		const text = await request.text();
		if (text.trim() !== "") body = JSON.parse(text);
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { sourceIds, nodeIds } = (body ?? {}) as { sourceIds?: unknown; nodeIds?: unknown };
	if ((sourceIds !== undefined && !isStringArray(sourceIds)) || (nodeIds !== undefined && !isStringArray(nodeIds))) {
		return Response.json({ error: "Body must be {sourceIds?: string[], nodeIds?: string[]}" }, { status: 400 });
	}
	try {
		return Response.json(await ankiSync.sync({ sourceIds, nodeIds }));
	} catch (err) {
		return ankiSyncErrorResponse(err);
	}
}
