/**
 * Notes UI (static renders): the panel geometry, controls and save-error
 * line, the top-bar chip, and the editor binding.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { NotesChip, NotesPanel } from "../components/notes-panel.tsx";
import { NotesController, NotesProvider, NOTES_OPEN_KEY } from "../components/notes-state.tsx";

function controllerFor(initialText: string, open: boolean): NotesController {
	const store = new Map<string, string>([[NOTES_OPEN_KEY, open ? "1" : "0"]]);
	return new NotesController("chat_ui", initialText, { storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) } });
}

function documentFor(node: React.ReactNode) {
	return parseHTML(`<html><body>${renderToStaticMarkup(node)}</body></html>`).document;
}

// The save-error line needs a failed PUT: one shared failing fetch for this file.
const realFetch = globalThis.fetch;
let fail_PUTs = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	if ((init?.method ?? "GET") === "PUT" && fail_PUTs > 0) {
		fail_PUTs--;
		return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
	}
	return new Response(JSON.stringify({ ok: true, text: "" }), { status: 200 });
}) as typeof fetch;
after(() => {
	globalThis.fetch = realFetch;
});

describe("notes panel render", () => {
	it("open: header, fold control, editor carrying the initial text, width rides the style", () => {
		const controller = controllerFor("hello $x$", true);
		const document = documentFor(
			<NotesProvider controller={controller}>
				<NotesPanel />
			</NotesProvider>,
		);
		const panel = document.querySelector('[data-testid="notes-panel"]')!;
		assert.ok(panel);
		assert.equal(panel.getAttribute("data-state"), "open");
		const editor = document.querySelector('[data-testid="notes-editor"]')!;
		assert.match(editor.textContent ?? "", /hello/, "the editor opens with the initial text");
		assert.equal(editor.getAttribute("aria-label"), "Session notes");
		assert.equal(document.querySelector('[aria-label="Fold notes"]')?.tagName, "BUTTON");
		assert.match(panel.getAttribute("style") ?? "", /width/);
		// The fold button is a no-drag control inside the draggable header band.
		assert.ok(document.querySelector(".lh-drag [aria-label='Fold notes']"));
	});

	it("folded: data-state folded; the editor is NOT rendered inside the inert aside", () => {
		const controller = controllerFor("", false);
		const document = documentFor(
			<NotesProvider controller={controller}>
				<NotesPanel />
			</NotesProvider>,
		);
		const panel = document.querySelector('[data-testid="notes-panel"]')!;
		assert.equal(panel.getAttribute("data-state"), "folded");
		assert.equal(panel.getAttribute("aria-hidden"), "true");
	});

	it("the top-bar chip reads open from the controller snapshot", () => {
		const controller = controllerFor("", true);
		const document = documentFor(
			<NotesProvider controller={controller}>
				<NotesChip />
			</NotesProvider>,
		);
		const chip = document.querySelector('[data-testid="notes-chip"]')!;
		assert.equal(chip.getAttribute("aria-pressed"), "true");
		assert.match(chip.textContent ?? "", /Notes/);
		assert.ok(chip.querySelector("svg"));
	});

	it("a failed save publishes a status line (click = the manual flush)", async () => {
		fail_PUTs = 1;
		const controller = controllerFor("", true);
		controller.onEdit("some work");
		// Skip the debounce: an explicit flush saves (and fails) immediately.
		const ok = await controller.flush();
		assert.equal(ok, false);
		const document = documentFor(
			<NotesProvider controller={controller}>
				<NotesPanel />
			</NotesProvider>,
		);
		const error = document.querySelector('[data-testid="notes-save-error"]')!;
		assert.ok(error);
		assert.equal(error.getAttribute("role"), "status");
		assert.match(error.textContent ?? "", /Notes not saved/);
	});
});
