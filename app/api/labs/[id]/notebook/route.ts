import type { LabNotebook } from "@/src/core";
import {
	getChat,
	getLabKernelState,
	readLabNotebook,
	writeLabNotebook,
} from "@/src/server";

export const dynamic = "force-dynamic";

function isValidNotebookShape(value: unknown): value is LabNotebook {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const nb = value as Partial<LabNotebook>;
	return nb.nbformat === 4 && Array.isArray(nb.cells);
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	try {
		const { notebook, revision } = readLabNotebook(chat.lab);
		const kernel = getLabKernelState(id);
		return Response.json({
			meta: chat.lab,
			notebook,
			revision,
			kernelStatus: kernel.status,
			...(kernel.interpreterPath ? { interpreterPath: kernel.interpreterPath } : {}),
			variables: kernel.variables,
		});
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not read notebook" },
			{ status: 500 },
		);
	}
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	const body = (await req.json().catch(() => null)) as { notebook?: unknown; expectedRevision?: unknown } | null;
	if (!body || !isValidNotebookShape(body.notebook)) {
		return Response.json({ error: "Invalid notebook payload" }, { status: 400 });
	}
	const expectedRevision = typeof body.expectedRevision === "string" ? body.expectedRevision : undefined;
	try {
		const res = writeLabNotebook(chat.lab, body.notebook, expectedRevision);
		if (!res.ok) {
			return Response.json(
				{ conflict: true, notebook: res.notebook, revision: res.revision },
				{ status: 409 },
			);
		}
		return Response.json({ notebook: res.notebook, revision: res.revision });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not save notebook" },
			{ status: 500 },
		);
	}
}
