import { normalizeLabNudgeLevel, type LabNudgeLevel } from "@/src/core";
import { getChat, updateLabNudgeLevel } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	const body = (await req.json().catch(() => null)) as { nudgeLevel?: unknown } | null;
	const raw = body?.nudgeLevel;
	if (raw !== "nudge" && raw !== "balanced" && raw !== "direct") {
		return Response.json({ error: "nudgeLevel must be nudge, balanced, or direct" }, { status: 400 });
	}
	const nudgeLevel: LabNudgeLevel = normalizeLabNudgeLevel(raw);
	const meta = updateLabNudgeLevel(id, chat.lab, nudgeLevel);
	return Response.json({ meta });
}
