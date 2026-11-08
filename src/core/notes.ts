/** Per-session lesson notes: Markdown with $…$ / $$…$$ LaTeX (`> ` lines are
 *  the tutor's words), stored on the chat record. Never enters `messages`. */

export const NOTES_MAX_CHARS = 100_000;

export class NotesInputError extends Error {}

/** Validate the save body `{ text }`; the text is returned untrimmed. */
export function parseNotesInput(raw: unknown): string {
	if (typeof raw !== "object" || raw === null) throw new NotesInputError("Body must be an object");
	const text = (raw as { text?: unknown }).text;
	if (typeof text !== "string") throw new NotesInputError("text must be a string");
	if (text.length > NOTES_MAX_CHARS) throw new NotesInputError(`Notes exceed ${NOTES_MAX_CHARS} characters`);
	return text;
}

// ─── last-write guard (stale-tab detection) ─────────────────────────────────
// The notes are one text field per session: two views (or tabs) of the same
// session can edit concurrently, and a plain last-write-wins would silently
// drop the other side's work. Every save carries the fingerprint of the text
// the caller last SAW; a mismatch answers 409 and the view warns before its
// next save re-reads. FNV-1a over UTF-16 code units, hex — collision odds are
// irrelevant here (a false positive only forces an honest extra re-read).

export function notesFingerprint(text: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
