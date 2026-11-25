import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { SideChatStore, sideBlockKey, type SideWindowView } from "../components/side-chat-state.tsx";
import { SideChatWindow } from "../components/side-chat.tsx";
import { SideThreadBody } from "../components/side-thread.tsx";
import type { SideChatAnchor, SideChatThread } from "../src/core/index.ts";

const anchor: SideChatAnchor = { messageId: "m1", partId: "m1-t0", blockIndex: 0, blockText: "Stokes' theorem." };
const thread: SideChatThread = {
	id: "side_reader_1",
	anchor,
	open: true,
	createdAt: "",
	messages: [
		{ id: "u1", role: "user", text: "Why does orientation matter?", at: "" },
		{ id: "a1", role: "assistant", text: "Reversing orientation flips the normal sign.", at: "" },
	],
};

describe("SentenceReader in side-chats", () => {
	it("renders SentenceReaderButton on settled SideAnswer messages when onOpenReader is wired", () => {
		const store = new SideChatStore("chat_reader");
		let opened: { text: string; partId: string } | null = null;
		store.onOpenReader = (p) => { opened = p; };

		const view: SideWindowView = {
			key: thread.id,
			renderKey: thread.id,
			blockKey: sideBlockKey("m1-t0", 0),
			anchor,
			thread,
			open: true,
			quotes: [],
			answering: false,
			streamText: "",
			sending: false,
			error: null,
		};
		const html = renderToStaticMarkup(<SideChatWindow view={view} store={store} />);
		const doc = parseHTML(`<html><body>${html}</body></html>`).document;
		const btn = doc.querySelector('[data-testid="sentence-reader-open"]');
		assert.ok(btn, "Read by sentence button renders on side-chat answer");
		assert.match(btn!.textContent!, /Read by sentence/);

		store.openReader("Test text", "side:side_reader_1:a1");
		assert.deepEqual(opened, { text: "Test text", partId: "side:side_reader_1:a1" });
	});

	it("renders SentenceReaderButton on SideThreadBody assistant messages when onOpenReader is provided", () => {
		const html = renderToStaticMarkup(
			<SideThreadBody
				chatId="chat_reader"
				state={{
					threadId: "t1",
					segmentId: "seg_1",
					mode: "panel",
					anchor: { kind: "composer" },
					messages: [
						{ id: "u1", role: "user", text: "Clarify?", at: "" },
						{ id: "a1", role: "assistant", text: "Here is a clear explanation.", at: "" },
					],
					answering: false,
					streamText: "",
				}}
				onAsk={async () => true}
				onStop={() => {}}
				onExpand={() => {}}
				onFloat={() => {}}
				onClose={() => {}}
				onOpenReader={() => {}}
			/>,
		);
		const doc = parseHTML(`<html><body>${html}</body></html>`).document;
		const btns = doc.querySelectorAll('[data-testid="sentence-reader-open"]');
		assert.equal(btns.length, 1);
	});
});
