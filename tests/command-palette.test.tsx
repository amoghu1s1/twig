import React, { act } from "react";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Root } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime.js";
import { parseHTML } from "linkedom";
import {
	COMMAND_PALETTE_EVENT,
	CommandPalette,
	GRAPH_FOCUS_NODE_EVENT,
	TOGGLE_NOTES_EVENT,
	TOGGLE_READINGS_EVENT,
	buildPaletteItems,
	builtInPaletteActions,
	rankPaletteItems,
} from "../components/command-palette.tsx";
import { SESSION_TAGS_KEY, saveSessionTags } from "../components/session-tags.ts";
import { InteractionLayersProvider, type InteractionLayersController, useInteractionLayers } from "../components/interaction-layers.tsx";
import { ServerEventsProvider } from "../components/server-events.tsx";
import { AppearanceProvider } from "../components/settings/appearance.tsx";
import { GraphCanvasRenderer } from "../components/graph-canvas.ts";
import { GraphView, computeNodeFocusCamera } from "../components/graph-view.tsx";
import { BUILTIN_THEMES, DEFAULT_THEME, kbdEventForAction, type ChatListItem, type GraphNode, type GraphSnapshot, type ReadingSummary } from "../src/core/index.ts";

(globalThis as Record<string, unknown>).React = React;

const sampleChats: ChatListItem[] = [
	{
		id: "c1",
		title: "Integration by parts",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 5,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
	},
	{
		id: "c2",
		title: "Recursive descent parser",
		kind: "practice",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-03T00:00:00.000Z",
		messageCount: 3,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: true,
		busy: false,
		compacting: false,
	},
	{
		id: "c3",
		title: "Compiler capstone",
		kind: "capstone",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-04T00:00:00.000Z",
		messageCount: 2,
		phase: "teach",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
	},
];

const sampleReadings: ReadingSummary[] = [
	{
		id: "r1",
		kind: "primer",
		mode: "researched",
		status: "ready",
		title: "Primer on Vector Fields",
		anchor: { chatId: "c1" },
		chatTitle: "Integration by parts",
		createdAt: "2026-01-02T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
	},
];

const sampleNodes: GraphNode[] = [
	{
		id: "n_bayes",
		name: "Bayes' theorem",
		statement: "Conditional probability relates prior and posterior beliefs.",
		aliases: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		provenance: [],
	},
	{
		id: "arg_imp1",
		name: "implication",
		statement: "internal geometry",
		aliases: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		provenance: [],
	},
];

describe("CommandPalette pure helpers", () => {
	it("includes all 14 required built-in actions and tool toggles", () => {
		const actions = builtInPaletteActions();
		assert.equal(actions.length, 14);
		const titles = actions.map((a) => a.title);
		for (const expected of [
			"New teaching session",
			"New practice session",
			"New capstone session",
			"Open Settings",
			"Open Knowledge Graph",
			"Open Readings library",
			"Open Review queue",
			"Open Mistakes",
			"Toggle Sidebar",
			"Toggle Notes",
			"Toggle Readings tray",
			"Toggle Scratchpad",
			"Toggle Calculator",
			"Read latest passage",
		]) {
			assert.ok(titles.includes(expected), `missing action: ${expected}`);
		}
	});

	it("builds items across actions, sessions (with tags), readings, and proposition nodes (filtering arg_)", () => {
		const items = buildPaletteItems({
			chats: sampleChats,
			readings: sampleReadings,
			nodes: sampleNodes,
			tagsMap: { c1: ["Multivariable Calculus", "MATH 201"] },
		});
		const sessions = items.filter((i) => i.category === "session");
		const readings = items.filter((i) => i.category === "reading");
		const nodes = items.filter((i) => i.category === "node");

		assert.equal(sessions.length, 3);
		assert.equal(sessions[0]!.badge, "Teaching");
		assert.deepEqual(sessions[0]!.tags, ["Multivariable Calculus", "MATH 201"]);
		assert.equal(sessions[1]!.badge, "Practice");
		assert.equal(sessions[2]!.badge, "Capstone");
		assert.deepEqual(sessions[0]!.execution, { kind: "route", href: "/chat/c1" });

		assert.equal(readings.length, 1);
		assert.equal(readings[0]!.badge, "Primer");
		assert.deepEqual(readings[0]!.execution, { kind: "route", href: "/readings/r1" });

		assert.equal(nodes.length, 1, "arg_ implication node is excluded");
		assert.equal(nodes[0]!.title, "Bayes' theorem");
		assert.deepEqual(nodes[0]!.execution, {
			kind: "route",
			href: "/?node=n_bayes",
			focusNodeId: "n_bayes",
		});
	});

	it("ranks matches across session titles, subject tags, readings, and graph node name/statement", () => {
		const items = buildPaletteItems({
			chats: sampleChats,
			readings: sampleReadings,
			nodes: sampleNodes,
			tagsMap: { c1: ["Multivariable Calculus"], c2: ["Python"] },
		});

		const byTag = rankPaletteItems(items, "calculus");
		assert.equal(byTag[0]!.id, "session:c1", "matches session by assigned subject tag");

		const byPython = rankPaletteItems(items, "python");
		assert.equal(byPython[0]!.id, "session:c2");

		const byNodeStatement = rankPaletteItems(items, "posterior beliefs");
		assert.equal(byNodeStatement[0]!.id, "node:n_bayes", "matches graph node statement");

		const byReading = rankPaletteItems(items, "vector fields");
		assert.equal(byReading[0]!.id, "reading:r1");

		assert.deepEqual(rankPaletteItems(items, "zzzz-no-match"), []);
	});
});

describe("computeNodeFocusCamera", () => {
	it("centers the target node in the viewport with label-visible zoom", () => {
		const positions = new Map([
			["n1", { x: -200, y: -100 }],
			["n2", { x: 200, y: 150 }],
		]);
		const view = computeNodeFocusCamera({ x: 200, y: 150 }, positions, { width: 1000, height: 800 }, 0.5);
		assert.ok(Math.abs(200 * view.k + view.x - 500) < 1e-6, "node x lands at viewport center");
		assert.ok(Math.abs(150 * view.k + view.y - 400) < 1e-6, "node y lands at viewport center");
		assert.deepEqual(view.anchor, { x: 500, y: 400 });
		assert.ok(view.k >= 0.5 && view.k <= 12);
	});

	it("handles single-node graphs cleanly without NaN or infinite zoom", () => {
		const positions = new Map([["n1", { x: 40, y: -25 }]]);
		const view = computeNodeFocusCamera({ x: 40, y: -25 }, positions, { width: 800, height: 600 }, 0.5);
		assert.equal(Number.isFinite(view.k), true);
		assert.equal(view.k, 3);
		assert.equal(40 * view.k + view.x, 400);
		assert.equal(-25 * view.k + view.y, 300);
	});
});

let root: Root | null = null;
let cleanupGlobals: (() => void) | null = null;

async function createDomFixture(opts: { search?: string } = {}) {
	const dom = parseHTML("<html><head></head><body><div id='root'></div><button id='opener'>Opener</button></body></html>");
	let active: Element = dom.document.querySelector("#opener")!;
	Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => active });

	const proto = dom.window.HTMLElement.prototype;
	const originalFocus = proto.focus;
	const originalBlur = proto.blur;
	const originalScrollIntoView = proto.scrollIntoView;
	const originalSetAttribute = proto.setAttribute;
	const legacyInputDescriptors = new Map(
		["attachEvent", "detachEvent"].map((key) => [key, Object.getOwnPropertyDescriptor(proto, key)]),
	);
	Object.assign(proto, { attachEvent() {}, detachEvent() {} });
	proto.setAttribute = function (name: string, value: string) {
		originalSetAttribute.call(this, name.toLowerCase(), value);
	};
	const scrollCalls: HTMLElement[] = [];
	proto.focus = function () {
		if (this.closest("[inert]") || this.hasAttribute("disabled")) return;
		active = this;
		this.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
	};
	proto.blur = function () {
		active = dom.document.body;
	};
	proto.scrollIntoView = function () {
		scrollCalls.push(this);
	};

	const style = (element: HTMLElement) => ({
		display: element.style.display || "block",
		visibility: element.style.visibility || "visible",
		opacity: element.style.opacity || "1",
		position: element.style.position || "static",
		overflow: element.style.overflow || "visible",
		fontFamily: "fixture-mono",
		paddingLeft: "0px",
		paddingRight: "0px",
		marginLeft: "0px",
		marginRight: "0px",
		borderLeftWidth: "0px",
		borderRightWidth: "0px",
		getPropertyValue: (name: string) => (element as HTMLElement).style.getPropertyValue(name),
	});

	const store = new Map<string, string>();
	const localStorageMock = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			store.set(k, String(v));
		},
		removeItem: (k: string) => {
			store.delete(k);
		},
	};
	Object.defineProperty(dom.window, "localStorage", { configurable: true, value: localStorageMock });
	Object.defineProperty(dom.window, "location", {
		configurable: true,
		value: { search: opts.search ?? "", pathname: "/", href: `http://localhost/${opts.search ?? ""}` },
	});
	Object.assign(dom.document, { oninput: null });
	const selectionStub = () => ({
		anchorNode: null,
		focusNode: null,
		anchorOffset: 0,
		focusOffset: 0,
		isCollapsed: true,
		rangeCount: 0,
	});
	Object.assign(dom.window, { getComputedStyle: style, innerWidth: 1000, innerHeight: 800, getSelection: selectionStub });

	const globals: Record<string, unknown> = {
		React,
		window: dom.window,
		self: dom.window,
		document: dom.document,
		HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element,
		Node: dom.window.Node,
		SVGElement: dom.window.SVGElement,
		HTMLInputElement: dom.window.HTMLInputElement,
		MutationObserver: dom.window.MutationObserver,
		CustomEvent: dom.window.CustomEvent,
		Event: dom.window.Event,
		localStorage: localStorageMock,
		navigator: { maxTouchPoints: 0, userAgent: "fixture", platform: "Linux" },
		NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
		getComputedStyle: style,
		getSelection: selectionStub,
		requestAnimationFrame: () => 1,
		cancelAnimationFrame: () => {},
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
		Path2D: class {},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const saved = new Map(Object.keys(globals).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
	for (const [k, v] of Object.entries(globals)) {
		Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
	}

	cleanupGlobals = () => {
		proto.focus = originalFocus;
		proto.blur = originalBlur;
		proto.scrollIntoView = originalScrollIntoView;
		proto.setAttribute = originalSetAttribute;
		for (const [key, desc] of legacyInputDescriptors) {
			if (desc) Object.defineProperty(proto, key, desc);
			else Reflect.deleteProperty(proto, key);
		}
		for (const [key, desc] of saved) {
			if (desc) Object.defineProperty(globalThis, key, desc);
			else Reflect.deleteProperty(globalThis, key);
		}
	};

	const { createRoot } = await import("react-dom/client");
	root = createRoot(dom.document.querySelector("#root")!);
	let controller!: InteractionLayersController;
	function Probe() {
		controller = useInteractionLayers();
		return null;
	}

	return {
		dom,
		store,
		scrollCalls,
		controller: () => controller,
		async render(node: React.ReactNode) {
			await act(async () => {
				root!.render(
					<InteractionLayersProvider>
						<Probe />
						{node}
					</InteractionLayersProvider>,
				);
			});
		},
		async key(target: HTMLElement, key: string, extra: Record<string, unknown> = {}) {
			const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
			Object.assign(event, { key, ...extra });
			await act(async () => {
				controller.captureKeyDown(event as unknown as KeyboardEvent);
				target.dispatchEvent(event);
			});
			return event;
		},
		async input(inputEl: HTMLInputElement, value: string) {
			await act(async () => {
				const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")?.set;
				setter?.call(inputEl, value);
				inputEl.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
			});
		},
	};
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = null;
	await new Promise((resolve) => setTimeout(resolve, 5));
	cleanupGlobals?.();
	cleanupGlobals = null;
});

describe("CommandPalette component behavior", () => {
	it("toggles open/closed via lh:kbd-command-palette, renders offline items immediately, and closes on Escape", async () => {
		const f = await createDomFixture();
		let resolveChats!: (v: Response) => void;
		const fetchStub = (input: unknown) => {
			if (String(input) === "/api/chats") {
				return new Promise<Response>((res) => {
					resolveChats = res;
				});
			}
			if (String(input) === "/api/readings") return Promise.resolve(Response.json({ readings: sampleReadings }));
			if (String(input) === "/api/graph") {
				return Promise.resolve(Response.json({ propositions: sampleNodes, nodes: sampleNodes }));
			}
			throw new Error(`Unexpected fetch: ${input}`);
		};
		const prevFetch = globalThis.fetch;
		globalThis.fetch = fetchStub as typeof fetch;
		const pushes: string[] = [];
		const router = {
			bfcacheId: "cp-test",
			back() {},
			forward() {},
			refresh() {},
			push(href: string) {
				pushes.push(href);
			},
			replace() {},
			prefetch() {},
		};

		try {
			await f.render(
				<AppRouterContext.Provider value={router}>
					<CommandPalette />
				</AppRouterContext.Provider>,
			);
			assert.equal(document.querySelector('[data-testid="command-palette"]'), null);

			await act(async () => {
				window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
			});
			const input = document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
			assert.ok(input, "palette opened");
			assert.equal(document.activeElement, input, "search input auto-focused via HostDialog");

			// Offline actions render before /api/chats settles
			const itemsBeforeChats = [...document.querySelectorAll('[data-testid="command-palette-item"]')];
			assert.ok(itemsBeforeChats.some((el) => el.textContent?.includes("New teaching session")));
			assert.ok(itemsBeforeChats.some((el) => el.textContent?.includes("Toggle Notes")));

			// Now resolve pending /api/chats
			await act(async () => {
				resolveChats(Response.json({ chats: sampleChats }));
			});

			// Escape closes via HostDialog / InteractionLayers
			await f.key(input, "Escape");
			assert.equal(document.querySelector('[data-testid="command-palette"]'), null);

			// Re-firing COMMAND_PALETTE_EVENT opens and second firing closes
			await act(async () => {
				window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
			});
			assert.ok(document.querySelector('[data-testid="command-palette"]'));
			await act(async () => {
				window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
			});
			assert.equal(document.querySelector('[data-testid="command-palette"]'), null);
		} finally {
			globalThis.fetch = prevFetch;
		}
	});

	it("cycles results with wrapping ArrowDown/ArrowUp, scrolls active row, and executes navigation/events/settings", async () => {
		const f = await createDomFixture();
		saveSessionTags({ c1: ["Multivariable Calculus"] });
		const prevFetch = globalThis.fetch;
		globalThis.fetch = (async (input: unknown) => {
			if (String(input) === "/api/chats") return Response.json({ chats: sampleChats });
			if (String(input) === "/api/readings") return Response.json({ readings: sampleReadings });
			if (String(input) === "/api/graph") return Response.json({ propositions: sampleNodes, nodes: sampleNodes });
			throw new Error(`Unexpected fetch: ${input}`);
		}) as typeof fetch;

		const pushes: string[] = [];
		const dispatched: Array<{ type: string; detail: unknown }> = [];
		let settingsOpened = 0;
		const router = {
			bfcacheId: "cp-test-2",
			back() {},
			forward() {},
			refresh() {},
			push(href: string) {
				pushes.push(href);
			},
			replace() {},
			prefetch() {},
		};
		const watchedEvents = [
			kbdEventForAction("toggle-sidebar"),
			TOGGLE_NOTES_EVENT,
			TOGGLE_READINGS_EVENT,
			kbdEventForAction("toggle-scratchpad"),
			kbdEventForAction("toggle-calculator"),
			kbdEventForAction("read-by-sentence"),
			GRAPH_FOCUS_NODE_EVENT,
		];
		const listeners = watchedEvents.map((ev) => {
			const fn = (e: Event) => dispatched.push({ type: ev, detail: (e as CustomEvent).detail });
			window.addEventListener(ev, fn);
			return [ev, fn] as const;
		});

		try {
			await f.render(
				<AppRouterContext.Provider value={router}>
					<CommandPalette onOpenSettings={() => { settingsOpened++; }} />
				</AppRouterContext.Provider>,
			);
			await act(async () => {
				window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
			});
			const input = document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;

			// Filter to Bayes' theorem via its statement and hit Enter
			await f.input(input, "posterior beliefs");
			const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="command-palette-item"]')];
			assert.equal(rows.length, 1);
			assert.ok(rows[0]!.textContent?.includes("Bayes' theorem"));
			assert.equal(rows[0]!.getAttribute("data-active"), "true");
			await f.key(input, "Enter");
			assert.equal(document.querySelector('[data-testid="command-palette"]'), null);
			assert.equal(pushes[0], "/?node=n_bayes");
			assert.deepEqual(dispatched.find((d) => d.type === GRAPH_FOCUS_NODE_EVENT)?.detail, { nodeId: "n_bayes" });

			// Re-open, filter by tag "calculus", verify ArrowUp/ArrowDown wrapping + scrollIntoView
			await act(async () => {
				window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
			});
			const input2 = document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
			await f.input(input2, "new ");
			const actionRows = [...document.querySelectorAll<HTMLElement>('[data-testid="command-palette-item"]')];
			assert.equal(actionRows.length, 3);
			assert.equal(actionRows[0]!.getAttribute("data-active"), "true");
			// Wrap backward from 0 -> 2 (New capstone session)
			await f.key(input2, "ArrowUp");
			const afterUp = [...document.querySelectorAll<HTMLElement>('[data-testid="command-palette-item"]')];
			assert.equal(afterUp[2]!.getAttribute("data-active"), "true");
			assert.ok(f.scrollCalls.includes(afterUp[2]!));
			// Wrap forward from 2 -> 0
			await f.key(input2, "ArrowDown");
			const afterDown = [...document.querySelectorAll<HTMLElement>('[data-testid="command-palette-item"]')];
			assert.equal(afterDown[0]!.getAttribute("data-active"), "true");
			await f.key(input2, "Enter");
			assert.equal(pushes.at(-1), "/chat/new");

			// Execute Settings action
			await act(async () => {
				window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
			});
			await f.input(document.querySelector('[data-testid="command-palette-input"]')!, "open settings");
			await f.key(document.querySelector('[data-testid="command-palette-input"]')!, "Enter");
			assert.equal(settingsOpened, 1);

			// Execute Toggle Notes + Read latest passage (ensuring HostDialog unmounted before dispatch)
			for (const [q, evName] of [
				["toggle notes", TOGGLE_NOTES_EVENT],
				["toggle readings tray", TOGGLE_READINGS_EVENT],
				["read latest passage", kbdEventForAction("read-by-sentence")],
			] as const) {
				await act(async () => {
					window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
				});
				const inp = document.querySelector<HTMLInputElement>('[data-testid="command-palette-input"]')!;
				await f.input(inp, q);
				await f.key(inp, "Enter");
				assert.ok(dispatched.some((d) => d.type === evName), `expected ${evName} dispatch`);
			}
			assert.equal(localStorage.getItem(SESSION_TAGS_KEY)?.includes("Multivariable Calculus"), true);
		} finally {
			for (const [ev, fn] of listeners) window.removeEventListener(ev, fn);
			globalThis.fetch = prevFetch;
		}
	});
});

describe("GraphView ?node=<id> deep-link focus", () => {
	it("centers the camera on ?node=<id> and opens its detail card without refetch loops", async (t) => {
		const f = await createDomFixture({ search: "?node=n2" });
		const canvasProto = Object.getPrototypeOf(f.dom.document.createElement("canvas"));
		const prevContext = Object.getOwnPropertyDescriptor(canvasProto, "getContext");
		Object.defineProperty(canvasProto, "getContext", {
			configurable: true,
			value() {
				return {
					fillStyle: "#000000",
					font: "12px monospace",
					setTransform() {},
					clearRect() {},
					fillRect() {},
					measureText: (s: string) => ({ width: s.length * 7 }),
					getImageData: () => ({ data: [10, 20, 30, 255] }),
				};
			},
		});

		const snapshot: GraphSnapshot = {
			nodes: [
				{ id: "n1", name: "First Idea", statement: "Statement one.", aliases: [], createdAt: "", provenance: [] },
				{ id: "n2", name: "Target Concept", statement: "Precise target statement.", aliases: [], createdAt: "", provenance: [] },
			],
			propositions: [
				{ id: "n1", name: "First Idea", statement: "Statement one.", aliases: [], createdAt: "", provenance: [] },
				{ id: "n2", name: "Target Concept", statement: "Precise target statement.", aliases: [], createdAt: "", provenance: [] },
			],
			edges: [],
			logicalEdges: [],
			impLinks: [],
			chains: [],
			sessions: { c1: "Linear Algebra" },
			fileSources: {},
			nodeSessions: { n1: ["c1"], n2: ["c1"] },
			clusters: [],
			positions: {
				n1: { x: -300, y: -200 },
				n2: { x: 400, y: 250 },
			},
		};

		let graphFetches = 0;
		const prevFetch = globalThis.fetch;
		globalThis.fetch = (async (input: unknown) => {
			switch (String(input)) {
				case "/api/themes":
					return Response.json({ themes: BUILTIN_THEMES });
				case "/api/graph":
					graphFetches++;
					return Response.json(snapshot);
				case "/api/graph/render-settings":
					return Response.json({});
				case "/api/graph/status":
					return Response.json({ runs: [] });
				case "/api/graph/costs":
					return Response.json(null);
				case "/api/readings?nodeId=n2":
				case "/api/readings?nodeId=n1":
					return Response.json({ readings: [] });
				default:
					throw new Error(`Unexpected fetch: ${input}`);
			}
		}) as typeof fetch;

		for (const method of ["setData", "setSettings", "setVisible", "setRegionTuning", "setPhysicsTuning"] as const) {
			t.mock.method(GraphCanvasRenderer.prototype, method, () => {});
		}
		const router = {
			bfcacheId: "graph-deep-link",
			back() {},
			forward() {},
			refresh() {},
			push() {},
			replace() {},
			prefetch() {},
		};

		try {
			await f.render(
				<AppRouterContext.Provider value={router}>
					<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
						<AppearanceProvider initialAppearance={{ theme: DEFAULT_THEME.id }} initialTheme={DEFAULT_THEME}>
							<GraphView />
						</AppearanceProvider>
					</ServerEventsProvider>
				</AppRouterContext.Provider>,
			);

			assert.equal(graphFetches, 1, "graph fetched exactly once");
			const card = document.querySelector<HTMLElement>('[data-testid="node-detail-card"]')!;
			assert.ok(card, "detail card opened for ?node=n2");
			assert.ok(card.textContent?.includes("Target Concept"));
			assert.ok(card.textContent?.includes("Precise target statement."));

			// Same-page deep-link jump via lh:graph-focus-node switches selection without refetching
			await act(async () => {
				window.dispatchEvent(new CustomEvent(GRAPH_FOCUS_NODE_EVENT, { detail: { nodeId: "n1" } }));
			});
			assert.equal(graphFetches, 1, "focus change does not re-fetch /api/graph");
			const updatedCard = document.querySelector<HTMLElement>('[data-testid="node-detail-card"]')!;
			assert.ok(updatedCard.textContent?.includes("First Idea"));
			assert.ok(updatedCard.textContent?.includes("Statement one."));
		} finally {
			t.mock.restoreAll();
			globalThis.fetch = prevFetch;
			if (prevContext) Object.defineProperty(canvasProto, "getContext", prevContext);
			else Reflect.deleteProperty(canvasProto, "getContext");
		}
	});
});
