/**
 * Per-session lesson notes (ChatRecord.notes).
 *
 * GET → { text } — the saved notes ("" when none). Re-read on mount,
 *  since Back/Forward can replay a stale page payload.
 * PUT → { text, base? } — save. `base`, when present, is the caller's
 *  notesFingerprint() of the text it last SAW: on mismatch the save is
 *  refused 409 with the current server text, so a second window's work
 *  is not silently dropped (the last-write guard; the client warns and
 *  re-reads, and its next save — carrying the fresh fingerprint + their
 *  newer edits — wins, as intended).
 */
import { notesFingerprint, NotesInputError, parseNotesInput } from "@/src/core";
import { readChatNotes, saveChatNotes } from "@/src/server";

/** The saved notes — re-read on mount, since Back/Forward can replay a stale page payload. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const text = readChatNotes((await params).id);
	if (text === null) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json({ text });
}

/** Save the session's Markdown notes — a per-field write on the record. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	let text: string;
	try {
		text = parseNotesInput(body);
	} catch (e) {
		if (e instanceof NotesInputError) return Response.json({ error: e.message }, { status: 400 });
		throw e;
	}
	// The stale-write guard runs AFTER validation, so a shaped save still
	// gets the shape error first.
	const current = readChatNotes(id);
	if (current === null) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (body && typeof body === "object" && "base" in body && body.base !== notesFingerprint(current)) {
		return Response.json(
			{ error: "The notes changed in another view. Reload to see them; saving again applies your latest edits on top.", text: current },
			{ status: 409 },
		);
	}
	if (!saveChatNotes(id, text)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json({ ok: true });
}
