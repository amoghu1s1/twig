import { countNewMistakes, enqueueAnalyses, listChats, readMistakes, recordAllMistakes } from "@/src/server";

export const dynamic = "force-dynamic";

/** Scan every saved session for mistakes not recorded yet (the backfill).
 *  Without `confirm` it only COUNTS (no writes, no model calls); with
 *  `confirm: true` it records them and starts their analyses. Failed and
 *  stuck-pending analyses are queued again too (the settings' cost cap still
 *  applies). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
	if (body?.confirm !== true) {
		const found = listChats().reduce((n, c) => n + countNewMistakes(c.id), 0);
		const retry = readMistakes().filter((r) => r.status !== "ready").length;
		return Response.json({ found, retry });
	}
	const added = recordAllMistakes();
	const redo = readMistakes().filter((r) => r.status !== "ready").map((r) => r.id);
	enqueueAnalyses([...new Set([...added, ...redo])]);
	return Response.json({ added: added.length, queued: new Set([...added, ...redo]).size });
}
