import { emit } from "@/src/core";
import {
	getChat,
	provisionLabWorkspace,
	shutdownLabKernel,
	stores,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	const body = (await req.json().catch(() => null)) as { workspaceDir?: unknown } | null;
	const workspaceDir = typeof body?.workspaceDir === "string" ? body.workspaceDir.trim() : "";
	if (!workspaceDir) {
		return Response.json({ error: "workspaceDir is required" }, { status: 400 });
	}
	try {
		await shutdownLabKernel(id);
		const provisioned = await provisionLabWorkspace({
			title: chat.title,
			workspaceDir,
			interpreterPath: chat.lab.interpreterPath,
			language: chat.lab.language,
		});
		stores.chatStore.saveLabMeta(id, provisioned.meta);
		emit("lab-changed", { chatId: id });
		return Response.json({ meta: provisioned.meta, notebook: provisioned.notebook });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Could not bind workspace directory" },
			{ status: 400 },
		);
	}
}
