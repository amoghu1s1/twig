/**
 * Notes Preview, Copy, Download .md, and Mod+P / Alt+N / Alt+R shortcuts
 * (interactive DOM tests via linkedom + createRoot + act).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import type { Root } from "react-dom/client";

const dom = parseHTML("<html><head></head><body></body></html>");
(dom.document as unknown as { oninput: null }).oninput = null;

let focused: HTMLElement = dom.document.body as unknown as HTMLElement;
Object.defineProperty(dom.document, "activeElement", {
	configurable: true,
	get: () => focused,
});

const proto = dom.window.HTMLElement.prototype as HTMLElement & {
	setSelectionRange?: (start: number, end: number) => void;
	scrollIntoView?: () => void;
};
const origFocus = proto.focus;
const origBlur = proto.blur;
proto.focus = function () {
	focused = this;
};
proto.blur = function () {
	focused = dom.document.body as unknown as HTMLElement;
};
proto.setSelectionRange = () => {};
proto.scrollIntoView = () => {};

const storageMap = new Map<string, string>();
const localStorageStub = {
	getItem: (k: string) => storageMap.get(k) ?? null,
	setItem: (k: string, v: string) => void storageMap.set(k, v),
	removeItem: (k: string) => void storageMap.delete(k),
	clear: () => void storageMap.clear(),
};

let clipboardWrites: string[] = [];
const clipboardStub = {
	writeText: async (text: string) => {
		clipboardWrites.push(text);
	},
};

const styleStub = (element: HTMLElement) => ({
	display: element.style.display || "block",
	visibility: element.style.visibility || "visible",
	opacity: element.style.opacity || "1",
	position: element.style.position || "static",
	overflow: element.style.overflow || "visible",
	animationName: "none",
	paddingLeft: "0px",
	paddingRight: "0px",
	marginLeft: "0px",
	marginRight: "0px",
	borderLeftWidth: "0px",
	borderRightWidth: "0px",
});

const realFetch = globalThis.fetch;
let serverNotesText = "";
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
	if (url.includes("/notes")) {
		if ((init?.method ?? "GET") === "PUT") {
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		}
		return new Response(JSON.stringify({ text: serverNotesText }), { status: 200 });
	}
	if (url.includes("/api/readings")) {
		return new Response(JSON.stringify({ readings: [] }), { status: 200 });
	}
	return new Response(JSON.stringify({}), { status: 200 });
}) as typeof fetch;

const globalsToSet: Record<string, unknown> = {
	window: dom.window,
	self: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
	MutationObserver: dom.window.MutationObserver,
	CustomEvent: dom.window.CustomEvent,
	getComputedStyle: styleStub,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
	ResizeObserver: class {
		observe() {}
		disconnect() {}
	},
	EventSource: class {
		onopen: (() => void) | null = null;
		addEventListener() {}
		close() {}
	},
	IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map(Object.keys(globalsToSet).map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)]));
Object.assign(globalThis, globalsToSet);
Object.assign(dom.window, {
	innerWidth: 1360,
	innerHeight: 800,
	localStorage: localStorageStub,
	getComputedStyle: styleStub,
});

const savedNavigatorClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, "clipboard");
Object.defineProperty(globalThis.navigator, "clipboard", { configurable: true, get: () => clipboardStub });

const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { InteractionLayersProvider } = await import("../components/interaction-layers.tsx");
const { KeyboardShortcuts } = await import("../components/keyboard-shortcuts.tsx");
const { NotesChip, NotesPanel } = await import("../components/notes-panel.tsx");
const { NotesController, NotesProvider, NOTES_OPEN_KEY } = await import("../components/notes-state.tsx");
const { ReadingsTray, useReadingsTray } = await import("../components/readings/readings-tray.tsx");
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { kbdEventForAction } = await import("../src/core/keyboard.ts");

after(() => {
	proto.focus = origFocus;
	proto.blur = origBlur;
	globalThis.fetch = realFetch;
	if (savedNavigatorClipboard) Object.defineProperty(globalThis.navigator, "clipboard", savedNavigatorClipboard);
	else Reflect.deleteProperty(globalThis.navigator, "clipboard");
	for (const [k, desc] of savedGlobals) {
		if (desc) Object.defineProperty(globalThis, k, desc);
		else Reflect.deleteProperty(globalThis, k);
	}
});

let root: Root | undefined;
let host: HTMLElement | undefined;

async function mount(node: React.ReactNode) {
	host = document.createElement("div") as unknown as HTMLElement;
	document.body.append(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(node);
	});
}

async function dispatchKey(
	target: EventTarget,
	key: string,
	mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string }> = {},
) {
	const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
	Object.assign(event, {
		key,
		code: mods.code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key),
		metaKey: false,
		ctrlKey: false,
		altKey: false,
		shiftKey: false,
		...mods,
	});
	await act(async () => {
		target.dispatchEvent(event);
	});
	return event;
}

function ShortcutsShell({ children }: { children?: React.ReactNode }) {
	const router = { bfcacheId: "notes-test", back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
	return (
		<InteractionLayersProvider>
			<AppRouterContext.Provider value={router}>
				<KeyboardShortcuts />
				{children}
			</AppRouterContext.Provider>
		</InteractionLayersProvider>
	);
}

function makeController(initialText = "", open = true) {
	serverNotesText = initialText;
	storageMap.set(NOTES_OPEN_KEY, open ? "1" : "0");
	return new NotesController("chat_test", initialText, {
		saveDelayMs: 10_000,
		storage: localStorageStub,
	});
}

const byTestId = <T extends HTMLElement = HTMLElement>(id: string) => {
	const found = document.querySelector<T>(`[data-testid="${id}"]`);
	assert.ok(found, `missing data-testid="${id}"`);
	return found;
};

beforeEach(() => {
	storageMap.clear();
	clipboardWrites = [];
	serverNotesText = "";
	focused = dom.document.body as unknown as HTMLElement;
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	root = undefined;
	host?.remove();
	host = undefined;
	document.body.innerHTML = "";
});

describe("keyboard shortcuts: Mod+P, Alt+N, Alt+R", () => {
	it("calls preventDefault and dispatches lh:kbd-command-palette, lh:kbd-toggle-notes, lh:kbd-toggle-readings (even inside typing surfaces)", async () => {
		const seen: string[] = [];
		const listeners = [
			kbdEventForAction("command-palette"),
			kbdEventForAction("toggle-notes"),
			kbdEventForAction("toggle-readings"),
		].map((name) => {
			const fn = () => seen.push(name);
			window.addEventListener(name, fn);
			return [name, fn] as const;
		});

		try {
			await mount(
				<ShortcutsShell>
					<input data-testid="typing-input" />
				</ShortcutsShell>,
			);
			const input = byTestId("typing-input");
			input.focus();

			const modMetaP = await dispatchKey(input, "p", { metaKey: true });
			const modCtrlP = await dispatchKey(input, "p", { ctrlKey: true });
			const altN = await dispatchKey(input, "n", { altKey: true });
			const altR = await dispatchKey(input, "r", { altKey: true });

			assert.equal(modMetaP.defaultPrevented, true, "Mod+P (Meta) prevents browser Print dialog");
			assert.equal(modCtrlP.defaultPrevented, true, "Mod+P (Ctrl) prevents browser Print dialog");
			assert.equal(altN.defaultPrevented, true, "Alt+N prevents default");
			assert.equal(altR.defaultPrevented, true, "Alt+R prevents default");
			assert.deepEqual(seen, [
				"lh:kbd-command-palette",
				"lh:kbd-command-palette",
				"lh:kbd-toggle-notes",
				"lh:kbd-toggle-readings",
			]);
		} finally {
			for (const [name, fn] of listeners) window.removeEventListener(name, fn);
		}
	});
});

describe("NotesPanel preview, shortcuts, copy, and download", () => {
	it("toggles open/folded on Alt+N (including when focus is inside the notes textarea) while bare keys stay isolated", async () => {
		const controller = makeController("hello", false);
		await mount(
			<ShortcutsShell>
				<NotesProvider controller={controller}>
					<NotesChip />
					<NotesPanel />
				</NotesProvider>
			</ShortcutsShell>,
		);

		assert.equal(byTestId("notes-panel").getAttribute("data-state"), "folded");

		// Open with Alt+N
		await dispatchKey(document.body, "n", { altKey: true });
		assert.equal(byTestId("notes-panel").getAttribute("data-state"), "open");
		assert.equal(byTestId("notes-chip").getAttribute("aria-pressed"), "true");

		// Focus the textarea: bare '?' must NOT open the cheat sheet; Alt+N still toggles notes closed.
		const editor = byTestId<HTMLTextAreaElement>("notes-editor");
		editor.focus();
		await dispatchKey(editor, "?", { shiftKey: true, code: "Slash" });
		assert.equal(document.querySelector('[data-testid="cheat-sheet"]'), null);

		await dispatchKey(editor, "n", { altKey: true });
		assert.equal(byTestId("notes-panel").getAttribute("data-state"), "folded");
		assert.equal(byTestId("notes-chip").getAttribute("aria-pressed"), "false");
	});

	it("toggles Markdown + KaTeX Preview, keeps NotesEditor mounted for quote-to-notes & refresh, and double-click focuses editor", async () => {
		const controller = makeController("**Chain rule**: $\\frac{dy}{dx} = \\frac{dy}{du} \\cdot \\frac{du}{dx}$\n\n$$\nE = mc^2\n$$", true);
		await mount(
			<NotesProvider controller={controller}>
				<NotesPanel />
			</NotesProvider>,
		);

		assert.equal(document.querySelector('[data-testid="notes-preview"]'), null);
		const toggleBtn = byTestId("notes-preview-toggle");
		assert.equal(toggleBtn.getAttribute("aria-pressed"), "false");

		await act(async () => {
			toggleBtn.click();
		});

		assert.equal(toggleBtn.getAttribute("aria-pressed"), "true");
		const preview = byTestId("notes-preview");
		assert.ok(preview.className.includes("lh-prose"));
		assert.ok(preview.className.includes("overflow-y-auto"));
		// Markdown + inline/display KaTeX rendered
		assert.equal(preview.querySelector("strong")?.textContent, "Chain rule");
		assert.equal(preview.querySelectorAll(".katex").length, 2);
		assert.equal(preview.querySelector(".katex-error"), null);

		// NotesEditor remains mounted in DOM (hidden wrapper) so port stays attached
		const editor = byTestId<HTMLTextAreaElement>("notes-editor");
		assert.ok(editor.closest(".hidden"), "editor remains mounted inside hidden container");

		// Quote-to-notes while Preview is active appends via port and reactively updates preview
		await act(async () => {
			controller.appendQuote("Tutor remark with $a^2 + b^2 = c^2$");
		});
		assert.equal(preview.querySelectorAll(".katex").length, 3);
		assert.ok(preview.querySelector("blockquote")?.textContent?.includes("Tutor remark"));

		// Server refresh updates preview reactively when clean
		await act(async () => {
			await controller.flush();
			serverNotesText = "# Synced Note\n\nUpdated $y = x^3$";
			await controller.refresh();
		});
		assert.equal(preview.querySelector("h1")?.textContent, "Synced Note");
		assert.equal(preview.querySelectorAll(".katex").length, 1);

		// Double-clicking preview switches back to Edit and focuses the textarea
		await act(async () => {
			preview.dispatchEvent(new dom.window.Event("dblclick", { bubbles: true }));
		});
		assert.equal(document.querySelector('[data-testid="notes-preview"]'), null);
		assert.equal(toggleBtn.getAttribute("aria-pressed"), "false");
		assert.equal(editor.closest(".hidden"), null);
		assert.equal(focused, editor);
	});

	it("shows the empty state in Preview when notes text is blank", async () => {
		const controller = makeController("   \n ", true);
		await mount(
			<NotesProvider controller={controller}>
				<NotesPanel />
			</NotesProvider>,
		);

		await act(async () => {
			byTestId("notes-preview-toggle").click();
		});

		const preview = byTestId("notes-preview");
		assert.match(preview.textContent ?? "", /No notes yet\. Switch to Edit to start writing\./);
	});

	it("copies notes to clipboard with CheckIcon confirmation and disables Copy/Download when empty", async () => {
		const controller = makeController("", true);
		await mount(
			<NotesProvider controller={controller}>
				<NotesPanel />
			</NotesProvider>,
		);

		const copyBtn = byTestId<HTMLButtonElement>("notes-copy");
		const downloadBtn = byTestId<HTMLButtonElement>("notes-download");
		assert.equal(copyBtn.disabled, true);
		assert.equal(downloadBtn.disabled, true);

		// Typing enables Copy and Download
		await act(async () => {
			controller.onEdit("Formula: $F = ma$");
		});
		assert.equal(copyBtn.disabled, false);
		assert.equal(downloadBtn.disabled, false);

		await act(async () => {
			copyBtn.click();
		});
		assert.deepEqual(clipboardWrites, ["Formula: $F = ma$"]);
		assert.ok(copyBtn.querySelector(".lucide-check"), "shows CheckIcon confirmation after copying");
	});

	it("downloads .md export using session title prop, DOM title fallback, or session-notes.md default", async () => {
		const origCreateObjectURL = URL.createObjectURL;
		const origRevokeObjectURL = URL.revokeObjectURL;
		const downloads: Array<{ name: string; type: string; text: string }> = [];
		const createdBlobs: Blob[] = [];
		URL.createObjectURL = ((blob: Blob) => {
			createdBlobs.push(blob);
			return `blob:mock-${createdBlobs.length}`;
		}) as typeof URL.createObjectURL;
		URL.revokeObjectURL = () => {};

		const origAnchorClick = dom.window.HTMLAnchorElement?.prototype?.click;
		const origCreateElement = document.createElement.bind(document);
		document.createElement = ((tag: string, options?: ElementCreationOptions) => {
			const el = origCreateElement(tag, options);
			if (tag.toLowerCase() === "a") {
				(el as unknown as HTMLAnchorElement).click = () => {
					const blob = createdBlobs[createdBlobs.length - 1]!;
					void blob.text().then((text) => {
						downloads.push({ name: el.getAttribute("download") ?? "", type: blob.type, text });
					});
				};
			}
			return el;
		}) as typeof document.createElement;

		try {
			// 1) Explicit title prop
			const c1 = makeController("Notes body 1", true);
			await mount(
				<NotesProvider controller={c1}>
					<NotesPanel title="Multivariable Calculus!" />
				</NotesProvider>,
			);
			await act(async () => {
				byTestId("notes-download").click();
				await new Promise((r) => setTimeout(r, 10));
			});

			// 2) DOM [data-plugin-chrome-title] fallback (no title prop, matching Chat)
			await act(async () => root?.unmount());
			host?.remove();
			const c2 = makeController("Notes body 2", true);
			await mount(
				<div className="flex">
					<button type="button" data-plugin-chrome-title>Eigenvalues &amp; Eigenvectors</button>
					<NotesProvider controller={c2}>
						<NotesPanel />
					</NotesProvider>
				</div>,
			);
			await act(async () => {
				byTestId("notes-download").click();
				await new Promise((r) => setTimeout(r, 10));
			});

			// 3) Default fallback when no title exists
			await act(async () => root?.unmount());
			host?.remove();
			const c3 = makeController("Notes body 3", true);
			await mount(
				<NotesProvider controller={c3}>
					<NotesPanel />
				</NotesProvider>,
			);
			await act(async () => {
				byTestId("notes-download").click();
				await new Promise((r) => setTimeout(r, 10));
			});

			assert.deepEqual(downloads, [
				{ name: "multivariable-calculus-notes.md", type: "text/markdown;charset=utf-8", text: "Notes body 1" },
				{ name: "eigenvalues-eigenvectors-notes.md", type: "text/markdown;charset=utf-8", text: "Notes body 2" },
				{ name: "session-notes.md", type: "text/markdown;charset=utf-8", text: "Notes body 3" },
			]);
		} finally {
			document.createElement = origCreateElement;
			if (origAnchorClick && dom.window.HTMLAnchorElement) dom.window.HTMLAnchorElement.prototype.click = origAnchorClick;
			URL.createObjectURL = origCreateObjectURL;
			URL.revokeObjectURL = origRevokeObjectURL;
		}
	});
});

describe("ReadingsTray Alt+R toggle", () => {
	function ReadingsHarness({ enabled }: { enabled: boolean }) {
		const tray = useReadingsTray("chat_r", enabled);
		return (
			<div>
				<span data-testid="readings-state">{tray.open ? "open" : "closed"}</span>
				{enabled && tray.open && (
					<ReadingsTray
						seam={tray.seam}
						readings={tray.readings}
						readingId={tray.readingId}
						onOpenReading={tray.setReadingId}
						onClose={() => tray.setOpen(false)}
						tree={null}
					/>
				)}
			</div>
		);
	}

	it("toggles the readings tray on Alt+R when enabled", async () => {
		await mount(
			<ServerEventsProvider>
				<ShortcutsShell>
					<ReadingsHarness enabled />
				</ShortcutsShell>
			</ServerEventsProvider>,
		);

		assert.equal(byTestId("readings-state").textContent, "closed");
		assert.equal(document.querySelector('[data-testid="readings-tray"]'), null);

		await dispatchKey(document.body, "r", { altKey: true });
		assert.equal(byTestId("readings-state").textContent, "open");
		assert.ok(byTestId("readings-tray"));

		await dispatchKey(document.body, "r", { altKey: true });
		assert.equal(byTestId("readings-state").textContent, "closed");
		assert.equal(document.querySelector('[data-testid="readings-tray"]'), null);
	});

	it("does not open on Alt+R when readings are disabled (practice/capstone)", async () => {
		await mount(
			<ServerEventsProvider>
				<ShortcutsShell>
					<ReadingsHarness enabled={false} />
				</ShortcutsShell>
			</ServerEventsProvider>,
		);

		await dispatchKey(document.body, "r", { altKey: true });
		assert.equal(byTestId("readings-state").textContent, "closed");
		assert.equal(document.querySelector('[data-testid="readings-tray"]'), null);
	});
});
