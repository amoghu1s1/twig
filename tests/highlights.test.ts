import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-highlights-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { GET, POST, PATCH, DELETE } = await import("../app/api/chats/[id]/highlights/route.ts");
const core = await import("../src/core/index.ts");
const {
	HighlightInputError,
	parseHighlightCreate,
	parseHighlightUpdate,
	newUserMessage,
	toLlmMessages,
} = core;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const validSelector = {
	text: "chain rule",
	start: 4,
	end: 14,
	prefix: "the ",
	suffix: " applies",
};

describe("highlights validation", () => {
	it("accepts valid tutor and side highlight payloads", () => {
		const tutor = parseHighlightCreate({
			sourceKind: "tutor",
			sourceId: "msg_1",
			selector: validSelector,
			color: "yellow",
		});
		assert.equal(tutor.sourceKind, "tutor");
		assert.equal(tutor.sideMessageId, undefined);

		const side = parseHighlightCreate({
			sourceKind: "side",
			sourceId: "side_1",
			sideMessageId: "a_1",
			selector: validSelector,
			color: "pink",
		});
		assert.equal(side.sourceKind, "side");
		assert.equal(side.sideMessageId, "a_1");
	});

	it("rejects invalid payloads with HighlightInputError", () => {
		assert.throws(
			() => parseHighlightCreate({ sourceKind: "other", sourceId: "m", selector: validSelector, color: "yellow" }),
			HighlightInputError,
		);
		assert.throws(
			() => parseHighlightCreate({ sourceKind: "side", sourceId: "side_1", selector: validSelector, color: "yellow" }),
			HighlightInputError,
		);
		assert.throws(
			() => parseHighlightCreate({ sourceKind: "tutor", sourceId: "m", selector: validSelector, color: "purple" }),
			HighlightInputError,
		);
		assert.throws(
			() => parseHighlightCreate({ sourceKind: "tutor", sourceId: "m", selector: { ...validSelector, end: 2 }, color: "blue" }),
			HighlightInputError,
		);
		assert.throws(
			() => parseHighlightUpdate({ highlightId: "", color: "green" }),
			HighlightInputError,
		);
	});
});

describe("highlights store & route CRUD", () => {
	it("persists highlights without bumping updatedAt or leaking into LLM messages", async () => {
		const chat = chatStore.createChat("Calc III");
		chatStore.saveMessages(chat.id, [newUserMessage("Explain Stokes theorem")]);
		const beforeUpdatedAt = chatStore.getChat(chat.id)!.updatedAt;

		const ctx = { params: Promise.resolve({ id: chat.id }) };
		const postRes = await POST(
			new Request("http://localhost/api/chats/x/highlights", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sourceKind: "tutor",
					sourceId: "msg_1",
					selector: validSelector,
					color: "green",
				}),
			}),
			ctx,
		);
		assert.equal(postRes.status, 201);
		const created = (await postRes.json()) as { highlight: { id: string; color: string } };
		assert.equal(created.highlight.color, "green");

		// updatedAt stays unchanged
		assert.equal(chatStore.getChat(chat.id)!.updatedAt, beforeUpdatedAt);
		// LLM projection ignores ChatRecord.highlights
		const llm = toLlmMessages(chatStore.getChat(chat.id)!.messages);
		assert.equal(llm.length, 1);

		const getRes = await GET(new Request("http://localhost"), ctx);
		assert.equal(getRes.status, 200);
		const listed = (await getRes.json()) as { highlights: Array<{ id: string; color: string }> };
		assert.equal(listed.highlights.length, 1);

		const patchRes = await PATCH(
			new Request("http://localhost", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ highlightId: created.highlight.id, color: "blue" }),
			}),
			ctx,
		);
		assert.equal(patchRes.status, 200);
		assert.equal(((await patchRes.json()) as { highlight: { color: string } }).highlight.color, "blue");

		const delRes = await DELETE(
			new Request(`http://localhost?highlightId=${encodeURIComponent(created.highlight.id)}`, { method: "DELETE" }),
			ctx,
		);
		assert.equal(delRes.status, 200);
		assert.equal(chatStore.getChat(chat.id)!.highlights, undefined, "emptying deletes the field");
	});

	it("returns 404 for unknown chat and 400 for malformed POST", async () => {
		const res404 = await GET(new Request("http://localhost"), { params: Promise.resolve({ id: "missing_chat" }) });
		assert.equal(res404.status, 404);

		const chat = chatStore.createChat("Bad Input");
		const res400 = await POST(
			new Request("http://localhost", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ bad: true }),
			}),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(res400.status, 400);
	});
});
