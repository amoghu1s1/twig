/**
 * The composer's ONE context control: local path references (the old
 * paperclip's job), attachment uploads (the old Add context's job), image
 * routing, and the session-files list. One button, one popover.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextAttachControl, pathsForFiles, type AttachmentDraft } from "../components/attachments.tsx";
import { PathInput } from "../components/path-input.tsx";
import { restorePathSelection } from "../components/path-input-dom.ts";
import { quoteFilePath } from "../src/core/file-paths.ts";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

function draft(files: File[] = []): AttachmentDraft & { added: File[] } {
	const state: AttachmentDraft & { added: File[] } = {
		files: files.map((file, i) => ({ key: `k${i}`, file })),
		added: [],
		error: null,
		add(list) {
			const next = Array.from(list ?? []);
			state.added.push(...next);
			state.files = [...state.files, ...next.map((file, i) => ({ key: `add${i}`, file }))];
		},
		remove() {},
		clear() {},
		upload: async () => [],
		identity: () => state.files.map((f) => f.key).join("|"),
	};
	return state;
}

async function fixture({ desktop = true, withImageDraft = false } = {}) {
	const { window: win, document: doc } = parseHTML("<html><body><div id='root'></div></body></html>");
	let active: Element = doc.body;
	Object.defineProperty(doc, "activeElement", { get: () => active });
	const selection = {
		anchorNode: null as Node | null, anchorOffset: 0, focusNode: null as Node | null, focusOffset: 0,
		setBaseAndExtent(anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) {
			Object.assign(this, { anchorNode, anchorOffset, focusNode, focusOffset });
		},
	};
	Object.assign(doc, { getSelection: () => selection, oninput: null });
	win.HTMLElement.prototype.focus = function () { active = this; };
	win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 200, y: 600, left: 200, right: 240, top: 600, bottom: 640, width: 40, height: 40, toJSON() {} });
	const backingPaths = new Map<File, string>();
	let folderCalls = 0;
	let folderResult: string | null | Error = null;
	let pickerClicks = 0;
	let imagePastes = 0;
	let value = "readthis";
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [name, next] of Object.entries({
		React, window: win, document: doc, Node: win.Node, HTMLElement: win.HTMLElement, Element: win.Element,
		Event: win.Event, CustomEvent: win.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
		requestAnimationFrame: (): number => 0, cancelAnimationFrame: (): void => {},
	})) {
		previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
		Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: next });
	}
	Object.defineProperty(win, "lh", {
		configurable: true,
		value: desktop ? {
			getPathForFile: (file: File) => backingPaths.get(file) ?? "",
			chooseAttachmentFolder: async () => { folderCalls++; if (folderResult instanceof Error) throw folderResult; return folderResult; },
		} : undefined,
	});
	const { createRoot } = await import("react-dom/client");
	const root = createRoot(doc.getElementById("root")!);
	const editorRef = { current: null as HTMLDivElement | null };
	const attachmentDraft = draft();
	function draw() {
		root.render(
			<div data-attachment-composer="">
				<ContextAttachControl
					draft={attachmentDraft}
					editorRef={editorRef}
					imageDraft={withImageDraft ? { onPaste: () => { imagePastes++; } } : undefined}
				/>
				<PathInput ref={editorRef} value={value} onValueChange={(next) => { value = next; draw(); }} />
			</div>,
		);
	}
	function draw() { root.render(<InteractionLayersProvider><Harness /></InteractionLayersProvider>); }
	await act(async () => { draw(); });
	const uploadPicker = doc.querySelector<HTMLInputElement>('[data-testid="attachment-input"]')!;
	uploadPicker.click = () => { pickerClicks++; };
	const referencePicker = doc.querySelector<HTMLInputElement>('[data-testid="reference-files-input"]')!;
	cleanup = async () => {
		await act(async () => { root.unmount(); });
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else delete (globalThis as Record<string, unknown>)[name];
		}
	};
	const editor = doc.querySelector<HTMLElement>("[data-file-path-input]")!;
	return {
		button: doc.querySelector<HTMLButtonElement>('[data-testid="attach-context"]')!,
		draft: attachmentDraft,
		get value() { return value; },
		doc,
		controller,
		get pickerClicks() { return pickerClicks; },
		get imagePastes() { return imagePastes; },
		setFolderResult(result: typeof folderResult) { folderResult = result; },
		get folderCalls() { return folderCalls; },
		async open() { await act(async () => { this.button.click(); }); },
		async clickTestId(id: string) {
			await act(async () => { doc.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click(); });
		},
		async resize() { await act(async () => { win.dispatchEvent(new win.Event("resize")); }); },
		async key(key: string) {
			const event = Object.assign(new win.Event("keydown", { bubbles: true, cancelable: true }), { key });
			const target = doc.querySelector<HTMLElement>('[data-testid="attachment-popover"]') ?? this.button;
			await act(async () => { target.dispatchEvent(event); });
			return event;
		},
		file(name: string, path?: string, type = "application/pdf") {
			const result = new File(["synthetic bytes"], name, { type });
			if (path !== undefined) backingPaths.set(result, path);
			return result;
		},
		caret(offset: number) {
			editor.focus();
			restorePathSelection(editor, { anchor: offset, focus: offset });
			doc.dispatchEvent(new win.Event("selectionchange"));
		},
		async pick(files: File[]) {
			Object.defineProperty(referencePicker, "files", { configurable: true, value: files });
			await act(async () => { referencePicker.dispatchEvent(new win.Event("change", { bubbles: true })); });
		},
		async upload(files: File[]) {
			Object.defineProperty(uploadPicker, "files", { configurable: true, value: files });
			await act(async () => { uploadPicker.dispatchEvent(new win.Event("change", { bubbles: true })); });
		},
	};
}

describe("one add-context entry point", () => {
	it("pathsForFiles keeps rooted paths and skips files the bridge can't place", () => {
		const a = new File([""], "a.pdf");
		const b = new File([""], "b.png");
		const c = new File([""], "c.txt");
		const paths = new Map<File, string>([[a, "/notes/a.pdf"], [b, "relative/b.png"]]);
		const result = pathsForFiles([a, b, c], (file) => {
			const path = paths.get(file);
			if (!path) throw new Error("no path");
			return path;
		});
		assert.deepEqual(result, { paths: ["/notes/a.pdf"], skipped: 2 });
	});

	it("server render is one paperclip with one hidden upload input", () => {
		const html = renderToStaticMarkup(<ContextAttachControl draft={draft()} />);
		assert.match(html, /data-testid="attach-context"/);
		assert.match(html, /Add context/);
		assert.match(html, /data-testid="attachment-input"/);
		assert.match(html, /accept="[^"]*\.epub[^"]*"/);
		assert.doesNotMatch(html, /attach-files|Attach images|composer-image-input|session-files-chip/);
	});

	it("the popover offers upload and both local-reference choices", async () => {
		const f = await fixture();
		await f.open();
		assert.ok(f.doc.querySelector('[data-testid="attachment-popover"]'));
		assert.deepEqual(
			Array.from(f.doc.querySelectorAll('[data-testid^="context-"]')).map((el) => el.getAttribute("data-testid")),
			["context-upload", "context-reference-files", "context-reference-folder"],
		);
	});

	it("desktop: Reference files keeps multi-file any-type chips at the caret, without reading bytes", async () => {
		const f = await fixture();
		f.caret(4);
		await f.open();
		await f.clickTestId("context-reference-files");
		const paths = ["/course/week 3.pdf", "/photos/board.jpg"];
		await f.pick([f.file("week 3.pdf", paths[0]), f.file("board.jpg", paths[1]), f.file("virtual.pdf")]);
		assert.equal(f.value, `read ${paths.map(quoteFilePath).join(" ")} this`);
	});

	it("desktop: Reference folder inserts exactly one directory path", async () => {
		const f = await fixture();
		f.caret(4);
		f.setFolderResult("/course/empty folder");
		await f.open();
		await f.clickTestId("context-reference-folder");
		assert.equal(f.value, "read `/course/empty folder/` this");
		assert.equal(f.folderCalls, 1);
	});

	for (const result of [null, "relative/folder", new Error("cancel/failure")]) it(`folder cancellation or error preserves the draft (${String(result)})`, async () => {
		const f = await fixture();
		f.caret(4);
		f.setFolderResult(result);
		await f.open();
		await f.clickTestId("context-reference-folder");
		assert.equal(f.value, "readthis");
	});

	it("browser: the reference choices explain instead of opening a picker", async () => {
		const f = await fixture({ desktop: false });
		await f.open();
		await f.clickTestId("context-reference-files");
		assert.match(f.doc.body.textContent ?? "", /Local file paths can only be attached in the desktop app/);
	});

	it("Upload files adds documents to the pending draft and routes images to the image draft", async () => {
		const f = await fixture({ withImageDraft: true });
		await f.open();
		await f.clickTestId("context-upload");
		assert.equal(f.pickerClicks, 1);
		await f.upload([f.file("notes.pdf", "/notes.pdf"), f.file("board.png", "/board.png", "image/png")]);
		assert.equal(f.imagePastes, 1, "the image went to the image draft");
		assert.deepEqual(f.draft.added.map((file) => file.name), ["notes.pdf"]);
	});

	it("Escape closes the popover without reaching the page's escape chain", async () => {
		const f = await fixture();
		await f.open();
		const event = await f.key("Escape");
		assert.equal(event.defaultPrevented, true);
		assert.equal(f.doc.querySelector('[data-testid="attachment-popover"]'), null);
	});
});
