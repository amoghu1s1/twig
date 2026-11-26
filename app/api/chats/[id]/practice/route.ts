import {
	isPracticeCoachingLevel,
	isPracticeDepth,
	isPracticePresentation,
	type PracticeSessionMeta,
} from "@/src/core";
import { getChat, updatePracticeMeta } from "@/src/server";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "practice") {
		return Response.json({ error: "Session is not a Practice session" }, { status: 400 });
	}
	const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const patch: Partial<PracticeSessionMeta> = {};
	if (body.coaching !== undefined) {
		if (!isPracticeCoachingLevel(body.coaching)) {
			return Response.json({ error: "coaching must be socratic, balanced, or direct" }, { status: 400 });
		}
		patch.coaching = body.coaching;
	}
	if (body.depth !== undefined) {
		if (!isPracticeDepth(body.depth)) {
			return Response.json({ error: "depth must be recall, adaptive, or deep" }, { status: 400 });
		}
		patch.depth = body.depth;
	}
	if (body.presentation !== undefined) {
		if (!isPracticePresentation(body.presentation)) {
			return Response.json({ error: "presentation must be auto, theory, or applied" }, { status: 400 });
		}
		patch.presentation = body.presentation;
	}
	if (body.verifySolutions !== undefined) {
		if (typeof body.verifySolutions !== "boolean") {
			return Response.json({ error: "verifySolutions must be boolean" }, { status: 400 });
		}
		patch.verifySolutions = body.verifySolutions;
	}

	const practice = updatePracticeMeta(id, patch);
	if (!practice) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json({ practice });
}
