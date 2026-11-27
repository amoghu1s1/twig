import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { AntigravityInstallationStatus, antigravityStatusLabel } from "../components/settings/antigravity-status.tsx";
import { ANTIGRAVITY_MINIMUM_VERSION, type AntigravityStatus } from "../src/core/contracts/antigravity.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const originalFetch = globalThis.fetch;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

const makeStatus = (
	state: AntigravityStatus["state"],
	version: string | null = null,
	modelCount = 0,
): AntigravityStatus => ({
	state,
	version,
	minimumVersion: ANTIGRAVITY_MINIMUM_VERSION,
	modelCount,
});

const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]')!;
const checkButton = () => document.querySelector<HTMLButtonElement>('[data-testid="antigravity-check-again"]')!;
const statusText = () => document.querySelector('[role="status"]')?.textContent;

function fixture(probe: () => Promise<Response>, enabled = false) {
	const calls: string[] = [];
	let on = enabled;
	globalThis.fetch = (async (url, init) => {
		calls.push(`${init?.method ?? "GET"} ${url}`);
		if (url === "/api/settings") return Response.json({ settings: { version: 1, antigravity: { enabled: on } } });
		if (url === "/api/settings/antigravity") {
			on = JSON.parse(String(init?.body)).enabled;
			return Response.json({ settings: { version: 1, antigravity: { enabled: on } } });
		}
		assert.equal(url, "/api/antigravity");
		assert.equal(new Headers(init?.headers).get("x-learnharness-antigravity"), "1");
		return probe();
	}) as typeof fetch;
	return calls;
}

async function mount() {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () => root!.render(<AntigravityInstallationStatus />));
}

afterEach(async () => {
	await act(async () => root?.unmount());
	host?.remove();
	root = undefined;
	host = undefined;
	globalThis.fetch = originalFetch;
});

test("status labels cover ready, not-signed-in, not-found, update-required, and unchecked", () => {
	assert.equal(antigravityStatusLabel(makeStatus("ready", "1.5.18", 11)), "Version 1.5.18 · 11 models");
	assert.equal(antigravityStatusLabel(makeStatus("ready", "1.5.18", 1)), "Version 1.5.18 · 1 model");
	assert.equal(antigravityStatusLabel(makeStatus("not-signed-in", "1.5.18", 0)), "Version 1.5.18 · sign in via terminal");
	assert.equal(antigravityStatusLabel(makeStatus("not-found")), "Not found");
	assert.equal(antigravityStatusLabel(makeStatus("update-required", "1.4.0")), "Version 1.4.0 · update required");
	assert.equal(antigravityStatusLabel(null), "Version could not be checked");
});

test("initial render is collapsed and off", () => {
	const html = renderToStaticMarkup(<AntigravityInstallationStatus />);
	assert.match(html, /Antigravity/);
	assert.match(html, /aria-checked="false"/);
	assert(!html.includes("Check again"));
});

test("enabling persists setting, probes /api/antigravity, and renders model count", async () => {
	const calls = fixture(async () => Response.json(makeStatus("ready", "1.5.18", 11)), false);
	await mount();
	assert.equal(toggle().getAttribute("aria-checked"), "false");
	assert.deepEqual(calls, ["GET /api/settings"]);

	await act(async () => toggle().click());
	assert.equal(toggle().getAttribute("aria-checked"), "true");
	assert.equal(statusText(), "Version 1.5.18 · 11 models");
	assert(calls.indexOf("PUT /api/settings/antigravity") < calls.indexOf("GET /api/antigravity"));
	assert(checkButton());
});
