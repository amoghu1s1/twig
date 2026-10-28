/**
 * /api/readings/[id] — one reading.
 *
 * GET    → the full record + costUsd + practice (the live "Practice this"
 *          set: its picked propositions, or what its session has produced).
 * DELETE → stops a live writer first, then removes the record. 404 unknown.
 */
import { deleteReading, getReading } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const reading = getReading(id);
	if (!reading) return Response.json({ error: "Not found" }, { status: 404 });
	return Response.json(reading);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!/^[A-Za-z0-9_-]+$/.test(id)) return Response.json({ error: "Not found" }, { status: 404 });
	return deleteReading(id) ? Response.json({ ok: true }) : Response.json({ error: "Not found" }, { status: 404 });
}
