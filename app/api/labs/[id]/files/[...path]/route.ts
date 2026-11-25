import {
	deleteWorkspaceFile,
	getChat,
	readWorkspaceFile,
	renameWorkspaceFile,
	writeWorkspaceFile,
} from "@/src/server";

export const dynamic = "force-dynamic";

function joinRelPath(segments: string[]): string {
	return segments.map((s) => decodeURIComponent(s)).join("/");
}

export async function GET(
	_req: Request,
	{ params }: { params: Promise<{ id: string; path: string[] }> },
) {
	const { id, path: pathSegments } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	try {
		const file = readWorkspaceFile(chat.lab.workspaceDir, joinRelPath(pathSegments));
		return Response.json(file);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "Could not read file";
		const status = /not found/i.test(msg) ? 404 : 400;
		return Response.json({ error: msg }, { status });
	}
}

export async function PUT(
	req: Request,
	{ params }: { params: Promise<{ id: string; path: string[] }> },
) {
	const { id, path: pathSegments } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	const body = (await req.json().catch(() => null)) as { content?: unknown } | null;
	if (!body || typeof body.content !== "string") {
		return Response.json({ error: "content must be a string" }, { status: 400 });
	}
	try {
		const saved = writeWorkspaceFile(chat.lab.workspaceDir, joinRelPath(pathSegments), body.content);
		return Response.json(saved);
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not save file" },
			{ status: 400 },
		);
	}
}

export async function DELETE(
	_req: Request,
	{ params }: { params: Promise<{ id: string; path: string[] }> },
) {
	const { id, path: pathSegments } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	try {
		deleteWorkspaceFile(chat.lab.workspaceDir, joinRelPath(pathSegments));
		return Response.json({ ok: true });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not delete file" },
			{ status: 400 },
		);
	}
}

export async function PATCH(
	req: Request,
	{ params }: { params: Promise<{ id: string; path: string[] }> },
) {
	const { id, path: pathSegments } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	const body = (await req.json().catch(() => null)) as { renameTo?: unknown } | null;
	if (!body || typeof body.renameTo !== "string" || !body.renameTo.trim()) {
		return Response.json({ error: "renameTo must be a non-empty path string" }, { status: 400 });
	}
	try {
		const renamed = renameWorkspaceFile(chat.lab.workspaceDir, joinRelPath(pathSegments), body.renameTo);
		return Response.json(renamed);
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not rename file" },
			{ status: 400 },
		);
	}
}
