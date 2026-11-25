import {
	getChat,
	getLabKernelState,
	inspectLabVariables,
	interruptLabKernel,
	probePythonInterpreter,
	restartLabKernel,
	setLabInterpreter,
	shutdownLabKernel,
} from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	const body = (await req.json().catch(() => null)) as { action?: unknown; interpreterPath?: unknown } | null;
	const action = body?.action;

	try {
		if (action === "interrupt") {
			await interruptLabKernel(id);
			return Response.json({ status: getLabKernelState(id).status });
		}
		if (action === "restart") {
			const status = await restartLabKernel(id, chat.lab);
			return Response.json({ status, variables: [] });
		}
		if (action === "shutdown") {
			await shutdownLabKernel(id);
			return Response.json({ status: "dead" });
		}
		if (action === "inspect_vars") {
			const variables = await inspectLabVariables(id);
			return Response.json({ variables, status: getLabKernelState(id).status });
		}
		if (action === "set_interpreter") {
			const interpreterPath = typeof body?.interpreterPath === "string" ? body.interpreterPath.trim() : "";
			if (!interpreterPath) {
				return Response.json({ error: "interpreterPath is required" }, { status: 400 });
			}
			const probed = await probePythonInterpreter(interpreterPath, "custom");
			if (!probed) {
				return Response.json({ error: `Not a working Python 3 executable: ${interpreterPath}` }, { status: 400 });
			}
			const updated = await setLabInterpreter(id, chat.lab, probed.path);
			return Response.json({ meta: updated.meta, status: updated.status, env: probed });
		}
		return Response.json({ error: "Unknown kernel action" }, { status: 400 });
	} catch (err) {
		return Response.json(
			{ error: err instanceof Error ? err.message : "Kernel action failed" },
			{ status: 500 },
		);
	}
}
