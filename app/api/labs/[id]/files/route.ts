import { createWorkspaceFolder, getChat, listWorkspaceFiles } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	try {
		const files = listWorkspaceFiles(chat.lab.workspaceDir);
		return Response.json({ workspaceDir: chat.lab.workspaceDir, files });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not list workspace files" },
			{ status: 400 },
		);
	}
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	const body = (await req.json().catch(() => null)) as { kind?: unknown; path?: unknown } | null;
	if (body?.kind !== "folder" || typeof body.path !== "string" || !body.path.trim()) {
		return Response.json({ error: 'Expected { kind: "folder", path }' }, { status: 400 });
	}
	try {
		const created = createWorkspaceFolder(chat.lab.workspaceDir, body.path);
		return Response.json(created);
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not create folder" },
			{ status: 400 },
		);
	}
}
