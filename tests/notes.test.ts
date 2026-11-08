/**
 * Per-session notes: the save lifetime (cap, blank-delete, list omission)
 * and the notes route — load, save, and the stale-write guard (a second
 * window's save is refused 409 with the current text instead of silently
 * dropping someone's work).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { GET: notesGET, PUT: notesPUT } = await import("../app/api/chats/[id]/notes/route.ts");
const { chatStore } = await import("../src/store/chats.ts");
const { saveChatNotes, readChatNotes } = await import("../src/server/chats.ts");
const { NOTES_MAX_CHARS, NotesInputError, notesFingerprint, parseNotesInput } = await import("../src/core/index.ts");
import { newUserMessage } from "../src/core/index.ts";

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const put = (id: string, body: unknown) => notesPUT(new Request(`http://localhost/api/chats/${id}/notes`, { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

describe("notes input", () => {
	it("accepts a string, refuses everything else and honors the 100k cap", () => {
		assert.equal(parseNotesInput({ text: "hello" }), "hello");
		assert.equal(parseNotesInput({ text: "" }), "");
		assert.equal(parseNotesInput({ text: " ".repeat(NOTES_MAX_CHARS) }).length, NOTES_MAX_CHARS);
		for (const bad of [null, "text", {}, { text: 5 }, { text: "x".repeat(NOTES_MAX_CHARS + 1) }]) {
			assert.throws(() => parseNotesInput(bad), NotesInputError);
		}
	});

	it("the fingerprint is stable and content-sensitive", () => {
		assert.equal(notesFingerprint("abc"), notesFingerprint("abc"));
		assert.notEqual(notesFingerprint("abc"), notesFingerprint("abd"));
		assert.notEqual(notesFingerprint("abc"), notesFingerprint("abcd"));
	});
});

describe("notes store", () => {
	it("saves per field, blank deletes the field, the side list omits it", () => {
		const chat = chatStore.createChat("notes");
		chatStore.saveMessages(chat.id, [newUserMessage("hello")]);
		assert.equal(saveChatNotes(chat.id, "My $\\tau$ note.\n\n> tutor words"), true);
		const record = chatStore.getChat(chat.id)!;
		assert.match(record.notes ?? "", /> tutor words/);
		// updatedAt did not move — session notes are not conversation activity.
		assert.equal(record.updatedAt, chatStore.getChat(chat.id)!.updatedAt);
		const summary = chatStore.listChats().find((c) => c.id === chat.id) as unknown as Record<string, unknown>;
		assert.equal(summary.notes, undefined);
		assert.equal(saveChatNotes(chat.id, "   "), true);
		assert.equal(chatStore.getChat(chat.id)!.notes, undefined);
		assert.equal(saveChatNotes("chat_missing", "x"), false);
		assert.equal(readChatNotes("chat_missing"), null);
		assert.equal(readChatNotes(chat.id), "");
	});
});

describe("notes route", () => {
	it("GETs saved text and 404s unknown chats", async () => {
		const chat = chatStore.createChat("route");
		assert.deepEqual(await (await notesGET(new Request("http://x"), { params: Promise.resolve({ id: chat.id }) })).json(), { text: "" });
		const missing = await notesGET(new Request("http://x"), { params: Promise.resolve({ id: "chat_missing" }) });
		assert.equal(missing.status, 404);
		await put(chat.id, { text: "saved" });
		assert.deepEqual(await (await notesGET(new Request("http://x"), { params: Promise.resolve({ id: chat.id }) })).json(), { text: "saved" });
	});

	it("PUT saves and validates the body", async () => {
		const chat = chatStore.createChat("route-put");
		assert.equal((await put(chat.id, null as unknown)).status, 400);
		assert.equal((await put(chat.id, { text: 5 })).status, 400);
		const saved = await put(chat.id, { text: "ok" });
		assert.equal(saved.status, 200);
		assert.equal((await saved.json()).ok, true);
		assert.equal(readChatNotes(chat.id), "ok");
		assert.equal((await put("chat_missing", { text: "ok" })).status, 404);
	});

	it("the stale-write guard: a save carrying a stale fingerprint is refused 409 with the current text", async () => {
		const chat = chatStore.createChat("route-cas");
		await put(chat.id, { text: "one" });
		// A second view saved since; the first view's base no longer matches.
		const refused = await put(chat.id, { text: "two-losing-later", base: notesFingerprint("") });
		assert.equal(refused.status, 409);
		const body = (await refused.json()) as { text?: string; error?: string };
		assert.equal(body.text, "one", "the current server text rides the refusal");
		assert.match(body.error ?? "", /another view/);
		assert.equal(readChatNotes(chat.id), "one", "the stale save landed nothing");
		// The honest save (fresh base) lands.
		assert.equal((await put(chat.id, { text: "three", base: notesFingerprint("one") })).status, 200);
		assert.equal(readChatNotes(chat.id), "three");
		// A save WITHOUT a base is last-write-wins (backwards compatible).
		assert.equal((await put(chat.id, { text: "four" })).status, 200);
	});
});
