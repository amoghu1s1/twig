/**
 * THE EDIT-LAST UI FLOW (issue #321), client half: whether the confirm
 * opens, and that the pencil actually asks for the rewind. The request
 * itself, the transcript adoption and the composer restore are pinned in
 * session-core.test.ts; the confirm copy in render-abort-turn-dialog.test.tsx.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { editNeedsConfirm } from "../components/chat.tsx";
import { EditMessageButton } from "../components/edit-message.tsx";

describe("editNeedsConfirm (the gate before a rewind)", () => {
	it("confirms when anything follows the message: editing discards that work", () => {
		assert.equal(editNeedsConfirm({ busy: false, hasReply: true }), true);
	});

	it("confirms while a turn streams, even before its reply lands in the record", () => {
		assert.equal(editNeedsConfirm({ busy: true, hasReply: false }), true);
	});

	it("edits at once when nothing has answered the message yet", () => {
		assert.equal(editNeedsConfirm({ busy: false, hasReply: false }), false);
	});
});

describe("EditMessageButton (the pencil asks the page to rewind)", () => {
	const dom = parseHTML("<html><body></body></html>");
	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	let root: Root;
	let host: HTMLDivElement;
	let createRoot: typeof import("react-dom/client").createRoot;

	before(async () => {
		for (const [key, value] of Object.entries({
			window: dom.window,
			document: dom.document,
			navigator: globals.navigator ?? { userAgent: "", platform: "" },
			HTMLElement: dom.window.HTMLElement,
			IS_REACT_ACT_ENVIRONMENT: true,
		})) {
			previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
			Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
		}
		({ createRoot } = await import("react-dom/client"));
		host = dom.document.createElement("div");
		dom.document.body.appendChild(host);
		root = createRoot(host);
	});

	after(async () => {
		await act(async () => root.unmount());
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	});

	it("a click hands the edit to the page exactly once", async () => {
		let edits = 0;
		await act(async () => root.render(createElement(EditMessageButton, { onEdit: () => { edits++; } })));
		const button = document.querySelector<HTMLButtonElement>('[data-testid="edit-message"]');
		assert.ok(button, "the control rendered");
		await act(async () => button.click());
		assert.equal(edits, 1);
	});
});
