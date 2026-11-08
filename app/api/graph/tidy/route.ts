/**
 * Tidy graph (src/server/graph-tidy.ts):
 *   GET                                  → TidyStatus (running, proposals)
 *   POST {action: "run"}                 → 202 started (409 when already running)
 *   POST {action: "apply"|"skip", ids}   → TidyResolveResult
 */

import { ankiSyncErrorResponse, graphTidy, TidyBusyError } from "@/src/server";
import { emit } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(graphTidy.status());
}

export async function POST(request: Request) {
	let body: { action?: unknown; ids?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (body.action === "run") {
		try {
			const { started } = graphTidy.start();
			emit("activity-changed", {});
			return Response.json({ started }, { status: started ? 202 : 409 });
		} catch (err) {
			return ankiSyncErrorResponse(err);
		}
	}
	if (body.action === "apply" || body.action === "skip") {
		if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
			return Response.json({ error: "ids must be a list of proposal ids" }, { status: 400 });
		}
		try {
			return Response.json(graphTidy.resolve(body.ids as string[], body.action));
		} catch (err) {
			if (err instanceof TidyBusyError) return Response.json({ error: err.message }, { status: 409 });
			throw err;
		}
	}
	return Response.json({ error: 'action must be "run", "apply" or "skip"' }, { status: 400 });
}
