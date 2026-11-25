import type { LabStreamEvent } from "@/src/core";
import { executeLabCell, getChat } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Not found" }, { status: 404 });
	if (chat.kind !== "lab" || !chat.lab) {
		return Response.json({ error: "Session is not a Lab" }, { status: 400 });
	}
	const labMeta = chat.lab;

	const body = (await req.json().catch(() => null)) as {
		cellId?: unknown;
		code?: unknown;
		markLearnerEdited?: unknown;
	} | null;
	if (!body || typeof body.cellId !== "string" || !body.cellId.trim()) {
		return Response.json({ error: "cellId is required" }, { status: 400 });
	}
	const cellId = body.cellId.trim();
	const code = typeof body.code === "string" ? body.code : undefined;
	const markLearnerEdited = typeof body.markLearnerEdited === "boolean" ? body.markLearnerEdited : undefined;

	const encoder = new TextEncoder();
	let closed = false;

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (event: LabStreamEvent) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
				} catch {
					closed = true;
				}
			};
			void executeLabCell(id, labMeta, { cellId, code, markLearnerEdited }, send)
				.catch((err) => {
					send({
						type: "kernel_error",
						message: err instanceof Error ? err.message : String(err),
					});
				})
				.finally(() => {
					if (closed) return;
					closed = true;
					try {
						controller.close();
					} catch {
						// already closed
					}
				});
		},
		cancel() {
			closed = true;
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
}
