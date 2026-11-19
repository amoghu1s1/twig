/**
 * Session-row render tests — the picker's status language (owner,
 * minimal-color round): ONE indicator, the braille spinner, present ONLY
 * while a teach turn is in flight; every other state (idle, question
 * pending) renders nothing — phases only advance, so phase-as-signal was
 * decoration, and question-pending is the dominant RESTING state (the
 * meta line's text carries it). Pure function of the list item, so SSR of
 * <SessionRow> pins every visible state. Same tsx classic-JSX shim as
 * render-cards.test.tsx.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { parseHTML } from "linkedom";
import { ActivityProvider } from "../components/activity-dock.tsx";
import { InteractionLayersProvider, useInteractionLayers, type InteractionLayersController } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { SessionRow, SessionsSidebar, SidebarProvider, timeAgo } from "../components/sidebar.tsx";
import { SESSION_TAGS_KEY, loadSessionTags, saveSessionTags } from "../components/session-tags.ts";
import type { ChatListItem } from "../src/core/index.ts";

function item(overrides: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1",
		title: "Test session",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 4,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

function render(chat: ChatListItem, active = false) {
	return renderToStaticMarkup(<SessionRow chat={chat} active={active} onOpen={() => {}} />);
}

describe("SessionRow", () => {
	it("no phase strips, no phase colors — the retired decoration", () => {
		const html = render(item({ phase: "teach" }));
		assert.ok(!html.includes("phase-strip"), "strip removed by design (too busy)");
		assert.ok(!html.includes("bg-phase-"), "phase fills are retired app-wide");
		assert.ok(!html.includes("border-phase-"), "phase rings are retired app-wide");
	});

	it("idle session: NO indicator — absence is the state", () => {
		for (const phase of ["probe", "plan", "teach"] as const) {
			const html = render(item({ phase }));
			assert.ok(!html.includes("session-dot"), "no dots — the status language is spinner-only");
			assert.ok(!html.includes("braille-spinner"), "idle never shows the spinner");
		}
	});

	it("a pending question renders NO indicator — resting state, carried by the meta text", () => {
		const html = render(item({ phase: "teach", pendingQuestion: true }));
		assert.ok(!html.includes("session-dot"), "no dots");
		assert.ok(!html.includes("braille-spinner"), "motion is reserved for working");
		assert.ok(html.includes("Waiting for input"), "the meta line's text");
		assert.ok(!html.includes("Waiting for your answer"), "old wording is gone");
	});

	it("a working session (turn in flight) renders the braille spinner — the ONLY indicator", () => {
		const html = render(item({ phase: "plan", busy: true }));
		assert.ok(html.includes('data-testid="braille-spinner"'), "the spinner");
		assert.ok(html.includes("braille-frame"), "CSS-animated frames");
		assert.ok((html.match(/class="braille-frame"/g) ?? []).length === 10, "all ten frames");
		assert.ok(html.includes('data-frame="0"'), "frame 0 leads (static fallback)");
		assert.ok(html.includes("Working"), "accessible label");
		assert.ok(!html.includes("bg-attention"), "no colored state fill — monochrome by design");
	});

	it("busy does not double-signal background agents (that is the sidebar section's channel)", () => {
		// The narrowing lives in the API route (busy = isTurnRunning only);
		// the row itself just renders busy faithfully. Pinned here so the
		// contract can't silently re-widen: an extraction-only "working"
		// row would be a double signal.
		const html = render(item({ busy: true, pendingQuestion: false }));
		assert.ok(html.includes("Working"), "the spinner's label names the turn, not agents");
	});

	it("the meta line: state replaces the count when the state is the useful fact", () => {
		// Local noon: timeAgo renders the local date, so a fixed UTC instant
		// lands on 2026-01-01 west of UTC.
		const awaiting = render(item({ pendingQuestion: true, updatedAt: new Date(2026, 0, 2, 12).toISOString() }));
		assert.ok(awaiting.includes("Waiting for input · 2026-01-02"), "awaiting meta keeps the existing date");
		assert.ok(!awaiting.includes("messages"), "count yields to the state");
		assert.ok(!awaiting.includes("braille-spinner"), "…and the spinner stays off");

		const working = render(item({ busy: true }));
		assert.ok(working.includes("Working…"), "working meta");

		// Owner, typography round 5: the message count is dropped — it
		// informed no decision. Idle meta is just how long ago.
		const idle = render(item({ title: "Partial derivatives", messageCount: 7 }));
		assert.ok(idle.includes("Partial derivatives"));
		assert.ok(!idle.includes("messages"), "the count is gone (flip-flop: one line in sessionMeta)");
		assert.match(idle, /\d{4}-\d{2}-\d{2}/, "idle shows the ISO date");
	});

	it("pending questions use the same wording for teach and practice with recent and old dates", () => {
		for (const kind of ["teach", "practice"] as const) {
			for (const updatedAt of [new Date().toISOString(), "2025-06-02T12:00:00.000Z"]) {
				const html = render(item({ kind, pendingQuestion: true, updatedAt }));
				assert.ok(html.includes(`Waiting for input · ${timeAgo(updatedAt)}`));
				assert.ok(!html.includes("Waiting for your answer"));
			}
		}
	});

	it("compacting retains priority over pending input", () => {
		const html = render(item({ compacting: true, pendingQuestion: true }));
		assert.match(html, /Compacting context ·/);
		assert.doesNotMatch(html, /Waiting for input/);
	});

	it("active row is visually marked by the background alone (owner, round 5: no weight change)", () => {
		const html = render(item({}), true);
		assert.ok(html.includes("bg-accent"), "active background");
		assert.ok(!html.includes("font-medium"), "weight is not a second channel doing the same job");
	});
});

describe("timeAgo", () => {
	const now = new Date("2026-01-02T12:00:00.000Z");

	it("just now / minutes / hours / days, then the ISO date (owner, round 5)", () => {
		assert.equal(timeAgo("2026-01-02T11:59:30.000Z", now), "just now");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now), "5m ago");
		assert.equal(timeAgo("2026-01-02T09:00:00.000Z", now), "3h ago");
		assert.equal(timeAgo("2025-12-31T12:00:00.000Z", now), "2d ago");
		// Local noon, so the local date is 2025-06-02 in every time zone.
		const old = new Date(2025, 5, 2, 12).toISOString();
		assert.equal(timeAgo(old, now), "2025-06-02", "beyond a week: ISO — unambiguous, sortable");
	});

	it("negative drift (clock skew) reads as just now, never a future date", () => {
		assert.equal(timeAgo("2026-01-02T12:01:00.000Z", now), "just now");
	});
});

describe("SessionRow practice badge (practice sessions, 2026-10-04)", () => {
	it("a practice row carries the dumbbell badge and the unified Working meta while busy (owner, 2026-10-10)", () => {
		const html = render(item({ kind: "practice", busy: true }));
		assert.match(html, /Working…/);
		assert.doesNotMatch(html, /Practicing…/);
		assert.match(html, /aria-label="Practice session"/);
	});

	it("a teaching row carries neither", () => {
		const html = render(item({}));
		assert.doesNotMatch(html, /Practice session/);
		assert.doesNotMatch(html, /Practicing…/);
	});

	it("busy teaching rows say the same unified Working", () => {
		const html = render(item({ busy: true }));
		assert.match(html, /Working…/);
	});

	it("a practice row with a posed problem says the problem is waiting", () => {
		const html = render(item({ kind: "practice", pendingProblem: true }));
		assert.match(html, /Problem waiting ·/);
	});

	it("pinned sessions show the pin indicator while unpinned sessions omit it", () => {
		const pinnedHtml = renderToStaticMarkup(<SessionRow chat={item({})} active={false} pinned onOpen={() => {}} />);
		const unpinnedHtml = render(item({}));
		assert.match(pinnedHtml, /aria-label="Pinned session"/);
		assert.doesNotMatch(unpinnedHtml, /aria-label="Pinned session"/);
	});
});

describe("SessionRow subject tag badges", () => {
	it("renders up to 2 compact muted tag pills plus +N overflow without font-medium", () => {
		const untagged = render(item({}));
		assert.ok(!untagged.includes('data-testid="session-row-tags"'));

		const twoTags = renderToStaticMarkup(
			<SessionRow chat={item({})} active={false} tags={["Python", "FEEX"]} onOpen={() => {}} />,
		);
		assert.ok(twoTags.includes("Python") && twoTags.includes("FEEX"));
		assert.ok(!twoTags.includes('data-testid="session-row-tag-overflow"'));
		assert.ok(!twoTags.includes("font-medium"));

		const fourTags = renderToStaticMarkup(
			<SessionRow
				chat={item({})}
				active={false}
				tags={["Multivariable Calculus", "Python", "FEEX", "Linear Algebra"]}
				onOpen={() => {}}
			/>,
		);
		assert.equal((fourTags.match(/data-testid="session-row-tag"/g) ?? []).length, 2);
		assert.ok(fourTags.includes("Multivariable Calculus") && fourTags.includes("Python"));
		assert.ok(!fourTags.includes("FEEX"));
		assert.ok(fourTags.includes("+2"));
		assert.ok(!fourTags.includes("font-medium"));
	});
});

let sidebarRoot: Root | null = null;
let sidebarCleanup: (() => void) | null = null;

async function mountSidebarFixture(initialChats: ChatListItem[], initialTags: Record<string, string[]> = {}) {
	const dom = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
	let active: Element = dom.document.body;
	Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => active });
	const proto = dom.window.HTMLElement.prototype;
	const origFocus = proto.focus;
	const origBlur = proto.blur;
	const origScroll = proto.scrollIntoView;
	const origSetAttr = proto.setAttribute;
	const origRect = proto.getBoundingClientRect;
	const legacyDescs = new Map(["attachEvent", "detachEvent"].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)]));
	Object.assign(proto, { attachEvent() {}, detachEvent() {} });
	proto.setAttribute = function (name: string, value: string) {
		origSetAttr.call(this, name.toLowerCase(), value);
	};
	proto.getBoundingClientRect = () => ({ top: 200, bottom: 230, left: 20, right: 200, width: 180, height: 30, x: 20, y: 200, toJSON() {} }) as DOMRect;
	proto.focus = function () {
		if (this.closest("[inert]") || this.hasAttribute("disabled")) return;
		active = this;
		this.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
	};
	proto.blur = function () {
		active = dom.document.body;
	};
	proto.scrollIntoView = () => {};

	const store = new Map<string, string>();
	if (Object.keys(initialTags).length > 0) store.set(SESSION_TAGS_KEY, JSON.stringify(initialTags));
	const storageMock = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			store.set(k, String(v));
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
	};
	const style = (el: HTMLElement) => ({
		display: el.style.display || "block",
		visibility: el.style.visibility || "visible",
		opacity: el.style.opacity || "1",
		position: el.style.position || "static",
		overflow: el.style.overflow || "visible",
		paddingLeft: "0px",
		paddingRight: "0px",
		marginLeft: "0px",
		marginRight: "0px",
		borderLeftWidth: "0px",
		borderRightWidth: "0px",
	});
	Object.defineProperty(dom.window, "localStorage", { configurable: true, value: storageMock });
	Object.assign(dom.document, { oninput: null });
	const selectionStub = () => ({
		anchorNode: null,
		focusNode: null,
		anchorOffset: 0,
		focusOffset: 0,
		isCollapsed: true,
		rangeCount: 0,
	});
	Object.assign(dom.window, { getComputedStyle: style, innerWidth: 1280, innerHeight: 800, getSelection: selectionStub });

	let chatsPayload = [...initialChats];
	const fetchMock = async (input: unknown, init?: RequestInit) => {
		const url = String(input);
		if (url === "/api/chats") return Response.json({ chats: chatsPayload });
		if (url === "/api/review") return Response.json({ due: [] });
		if (url === "/api/activity") return Response.json({ jobs: [], extractions: [], readings: [], discussions: [], pluginWorkers: [] });
		if (url.startsWith("/api/chats/") && init?.method === "DELETE") {
			const id = url.slice("/api/chats/".length).split("?")[0]!;
			chatsPayload = chatsPayload.filter((c) => c.id !== id);
			return Response.json({ ok: true, graphRevision: 2 });
		}
		if (url.startsWith("/api/chats/")) return Response.json({ coverage: null });
		throw new Error(`Unexpected sidebar fixture fetch: ${url}`);
	};

	const globals: Record<string, unknown> = {
		React,
		window: dom.window,
		self: dom.window,
		document: dom.document,
		HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element,
		Node: dom.window.Node,
		HTMLInputElement: dom.window.HTMLInputElement,
		MutationObserver: dom.window.MutationObserver,
		CustomEvent: dom.window.CustomEvent,
		Event: dom.window.Event,
		localStorage: storageMock,
		navigator: { maxTouchPoints: 0, userAgent: "fixture", platform: "Linux" },
		NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
		cancelAnimationFrame: clearTimeout,
		getComputedStyle: style,
		getSelection: selectionStub,
		fetch: fetchMock,
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
	for (const [k, v] of Object.entries(globals)) {
		Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
	}

	sidebarCleanup = () => {
		proto.focus = origFocus;
		proto.blur = origBlur;
		proto.scrollIntoView = origScroll;
		proto.setAttribute = origSetAttr;
		proto.getBoundingClientRect = origRect;
		for (const [k, d] of legacyDescs) {
			if (d) Object.defineProperty(proto, k, d);
			else Reflect.deleteProperty(proto, k);
		}
		for (const [k, d] of saved) {
			if (d) Object.defineProperty(globalThis, k, d);
			else Reflect.deleteProperty(globalThis, k);
		}
	};

	const { createRoot } = await import("react-dom/client");
	sidebarRoot = createRoot(dom.document.querySelector("#root")!);
	let controller!: InteractionLayersController;
	function Probe() {
		controller = useInteractionLayers();
		return null;
	}
	const router = { bfcacheId: "sb", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };

	return {
		dom,
		controller: () => controller,
		async mount() {
			await act(async () => {
				sidebarRoot!.render(
					<AppRouterContext.Provider value={router}>
						<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
							<InteractionLayersProvider>
								<Probe />
								<SidebarProvider>
									<ActivityProvider>
										<SessionsSidebar />
									</ActivityProvider>
								</SidebarProvider>
							</InteractionLayersProvider>
						</ServerEventsProvider>
					</AppRouterContext.Provider>,
				);
			});
		},
		async click(el: Element) {
			await act(async () => {
				el.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
			});
		},
		async contextMenu(el: Element) {
			await act(async () => {
				el.dispatchEvent(new dom.window.Event("contextmenu", { bubbles: true, cancelable: true }));
			});
		},
		async type(inputEl: HTMLInputElement, value: string) {
			await act(async () => {
				const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
				setter?.call(inputEl, value);
				inputEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			});
		},
		async key(el: HTMLElement, key: string) {
			const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(ev, { key });
			await act(async () => {
				controller.captureKeyDown(ev as unknown as KeyboardEvent);
				el.dispatchEvent(ev);
			});
		},
	};
}

afterEach(async () => {
	await act(async () => {
		sidebarRoot?.unmount();
	});
	sidebarRoot = null;
	await new Promise((r) => setTimeout(r, 5));
	sidebarCleanup?.();
	sidebarCleanup = null;
});

describe("SessionsSidebar subject tags UX", () => {
	it("filters by subject tag pill, searches by title or tag, edits via context menu dialog, and cleans up on delete", async () => {
		const chats = [
			item({ id: "c1", title: "Stokes Theorem", updatedAt: "2026-01-03T00:00:00.000Z" }),
			item({ id: "c2", title: "Circuit Analysis", updatedAt: "2026-01-02T00:00:00.000Z" }),
			item({ id: "c3", title: "Decorators", updatedAt: "2026-01-01T00:00:00.000Z" }),
		];
		const f = await mountSidebarFixture(chats, {
			c1: ["Multivariable Calculus"],
			c2: ["FEEX"],
		});
		await f.mount();

		// Tag filter bar appears beneath kind filter with All + sorted pills with counts
		const filterBar = document.querySelector('[data-testid="session-tag-filter"]');
		assert.ok(filterBar, "tag filter bar rendered");
		const pills = [...document.querySelectorAll<HTMLElement>('[data-testid="tag-filter-pill"]')];
		assert.deepEqual(
			pills.map((p) => p.getAttribute("data-tag")),
			["FEEX", "Multivariable Calculus"],
		);

		// Clicking a tag filters rows; clicking again toggles back to All
		const feexPill = pills.find((p) => p.getAttribute("data-tag") === "FEEX")!;
		await f.click(feexPill);
		let visibleRows = [...document.querySelectorAll('[data-testid="session-row"]')];
		assert.equal(visibleRows.length, 1);
		assert.ok(visibleRows[0]!.textContent?.includes("Circuit Analysis"));

		await f.click(document.querySelector('[data-tag="FEEX"]')!);
		visibleRows = [...document.querySelectorAll('[data-testid="session-row"]')];
		assert.equal(visibleRows.length, 3);

		// Searching by assigned subject tag matches even when title lacks the term
		const search = document.querySelector<HTMLInputElement>('[data-testid="session-search"]')!;
		await f.type(search, "calculus");
		visibleRows = [...document.querySelectorAll('[data-testid="session-row"]')];
		assert.equal(visibleRows.length, 1);
		assert.ok(visibleRows[0]!.textContent?.includes("Stokes Theorem"));
		await f.type(search, "");

		// Right-click row 3 ("Decorators") -> ctx-tags above ctx-delete -> open tag editor
		const row3 = [...document.querySelectorAll('[data-testid="session-row"]')][2]!;
		await f.contextMenu(row3);
		const menu = document.querySelector('[data-testid="session-context-menu"]')!;
		assert.ok(menu);
		const menuButtons = [...menu.querySelectorAll("button")].map((b) => b.getAttribute("data-testid"));
		assert.ok(menuButtons.includes("ctx-tags"));
		assert.ok(menuButtons.indexOf("ctx-tags") < menuButtons.indexOf("ctx-delete"));

		await f.click(menu.querySelector('[data-testid="ctx-tags"]')!);
		const dialog = document.querySelector('[data-testid="session-tags-dialog"]')!;
		assert.ok(dialog);

		// Add a new subject via Enter
		const tagInput = dialog.querySelector<HTMLInputElement>('[data-testid="tag-editor-input"]')!;
		await f.type(tagInput, "Python");
		await f.key(tagInput, "Enter");
		assert.deepEqual(loadSessionTags().c3, ["Python"]);

		// One-click toggle existing subject ("FEEX") onto c3
		const feexToggle = dialog.querySelector('[data-testid="tag-editor-toggle"][data-tag="FEEX"]')!;
		await f.click(feexToggle);
		assert.deepEqual(loadSessionTags().c3, ["Python", "FEEX"]);

		// Remove "FEEX" via × button
		const removeFeex = dialog.querySelector('[data-testid="tag-editor-remove"][data-tag="FEEX"]')!;
		await f.click(removeFeex);
		assert.deepEqual(loadSessionTags().c3, ["Python"]);

		// Close tag dialog with Done
		await f.click(dialog.querySelector('[data-testid="tag-editor-done"]')!);
		assert.equal(document.querySelector('[data-testid="session-tags-dialog"]'), null);

		// Delete c3 and confirm tags are cleaned up via onDeleted
		const row3Updated = [...document.querySelectorAll('[data-testid="session-row"]')][2]!;
		await f.contextMenu(row3Updated);
		await f.click(document.querySelector('[data-testid="ctx-delete"]')!);
		await f.click(document.querySelector('[data-testid="delete-confirm"]')!);
		assert.equal(Object.hasOwn(loadSessionTags(), "c3"), false);
		assert.equal(document.querySelectorAll('[data-testid="session-row"]').length, 2);
	});
});

