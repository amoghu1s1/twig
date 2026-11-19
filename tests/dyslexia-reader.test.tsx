import React, { act } from "react";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
	DEFAULT_THEME,
	READER_PREFS_KEY,
	parseReaderPrefs,
	type AppearanceSettings,
} from "../src/core/index.ts";
import { AppearanceProvider, useAppearance } from "../components/settings/appearance.tsx";
import { AppearanceSection, CURATED_FALLBACK_FONTS } from "../components/settings/appearance-section.tsx";
import { InteractionLayersProvider } from "../components/interaction-layers.tsx";
import { SentenceReader } from "../components/sentence-reader.tsx";

(globalThis as Record<string, unknown>).React = React;

function createStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, String(value));
		},
		removeItem: (key: string) => {
			map.delete(key);
		},
		clear: () => map.clear(),
	};
}

async function withDom(fn: (dom: ReturnType<typeof parseHTML>, sendKey: (key: string) => Promise<void>) => Promise<void>) {
	const dom = parseHTML("<html><body><div id='root'></div></body></html>");
	// React 19 checks `"oninput" in document` once on module load to enable native input/change tracking.
	Object.defineProperty(dom.document, "oninput", { configurable: true, writable: true, value: null });
	if (typeof dom.window.HTMLElement.prototype.scrollIntoView !== "function") {
		dom.window.HTMLElement.prototype.scrollIntoView = () => {};
	}
	const localStorage = createStorage();
	const sessionStorage = createStorage();
	Object.defineProperty(dom.window, "matchMedia", {
		configurable: true,
		value: (query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addEventListener() {},
			removeEventListener() {},
			addListener() {},
			removeListener() {},
			dispatchEvent() {
				return false;
			},
		}),
	});
	Object.defineProperty(dom.window, "getSelection", {
		configurable: true,
		value: () => ({ isCollapsed: true }),
	});
	Object.defineProperty(dom.window, "localStorage", { configurable: true, value: localStorage });
	Object.defineProperty(dom.window, "sessionStorage", { configurable: true, value: sessionStorage });

	// Linkedom does not fire window capture listeners on window.dispatchEvent.
	const captures = new Set<EventListenerOrEventListenerObject>();
	const origAdd = dom.window.addEventListener.bind(dom.window);
	const origRemove = dom.window.removeEventListener.bind(dom.window);
	dom.window.addEventListener = ((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	) => {
		if (type === "keydown" && (options === true || (typeof options === "object" && options.capture))) {
			captures.add(listener);
		} else {
			origAdd(type, listener, options);
		}
	}) as typeof dom.window.addEventListener;
	dom.window.removeEventListener = ((
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions,
	) => {
		if (type === "keydown" && (options === true || (typeof options === "object" && options.capture))) {
			captures.delete(listener);
		} else {
			origRemove(type, listener, options);
		}
	}) as typeof dom.window.removeEventListener;

	const globals = globalThis as Record<string, unknown>;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	const bindings: Record<string, unknown> = {
		window: dom.window,
		document: dom.document,
		HTMLElement: dom.window.HTMLElement,
		Element: dom.window.Element,
		Node: dom.window.Node,
		HTMLInputElement: dom.window.HTMLInputElement,
		HTMLSelectElement: dom.window.HTMLSelectElement,
		HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
		Event: dom.window.Event,
		localStorage,
		sessionStorage,
		IS_REACT_ACT_ENVIRONMENT: true,
		fetch: async (url: string) => {
			if (url === "/api/themes") return Response.json({ themes: [DEFAULT_THEME] });
			throw new Error(`Unexpected fetch: ${url}`);
		},
	};
	for (const [key, value] of Object.entries(bindings)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	const sendKey = async (key: string) => {
		const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(event, { key });
		await act(async () => {
			for (const listener of [...captures]) {
				if (typeof listener === "function") listener.call(dom.window, event);
				else listener.handleEvent(event);
				if (event.cancelBubble) break;
			}
			if (!event.cancelBubble) dom.window.dispatchEvent(event);
		});
	};
	try {
		await fn(dom, sendKey);
	} finally {
		dom.window.addEventListener = origAdd;
		dom.window.removeEventListener = origRemove;
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else delete globals[key];
		}
	}
}

function setFormValue(
	element: HTMLInputElement | HTMLSelectElement,
	value: string,
	dom: ReturnType<typeof parseHTML>,
	eventName: "input" | "change",
) {
	if (element instanceof dom.window.HTMLSelectElement) {
		Object.defineProperty(element, "value", { configurable: true, writable: true, value });
	} else {
		let proto: object | null = Object.getPrototypeOf(element);
		let setter: ((v: string) => void) | undefined;
		while (proto && !setter) {
			setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			proto = Object.getPrototypeOf(proto);
		}
		if (setter) setter.call(element, value);
		else element.value = value;
	}
	element.dispatchEvent(new dom.window.Event(eventName, { bubbles: true }));
}

describe("bundled dyslexia-friendly fonts and CSS tokens", () => {
	it("loads Atkinson_Hyperlegible_Next and Lexend in app/layout.tsx and defines spacing tokens in app/globals.css", () => {
		const layout = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");
		assert.match(layout, /Atkinson_Hyperlegible_Next/);
		assert.match(layout, /Lexend/);
		assert.match(layout, /--font-atkinson/);
		assert.match(layout, /--font-lexend/);
		assert.match(layout, /\$\{atkinson\.variable\}/);
		assert.match(layout, /\$\{lexend\.variable\}/);

		const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
		assert.match(css, /--lh-prose-letter-spacing:\s*normal;/);
		assert.match(css, /--lh-prose-word-spacing:\s*normal;/);
		assert.match(css, /letter-spacing:\s*var\(--lh-prose-letter-spacing\);/);
		assert.match(css, /word-spacing:\s*var\(--lh-prose-word-spacing\);/);
		assert.equal((css.match(/font-variant-ligatures:/g) ?? []).length, 1);

		assert.ok(CURATED_FALLBACK_FONTS.includes("Atkinson Hyperlegible Next"));
		assert.ok(CURATED_FALLBACK_FONTS.includes("Lexend"));
	});
});

describe("AppearanceSection dyslexia preset & spacing controls", () => {
	it("toggles Dyslexia-friendly preset on and back off, updating live CSS variables", async () => {
		await withDom(async (dom) => {
			const { createRoot } = await import("react-dom/client");
			const root = createRoot(document.getElementById("root")!);
			const writes: AppearanceSettings[] = [];
			function Panel() {
				const { appearance, onAppearanceChange } = useAppearance();
				return (
					<AppearanceSection
						appearance={appearance}
						onSectionChange={(next) => {
							writes.push(next);
							onAppearanceChange(next);
							return true;
						}}
					/>
				);
			}
			try {
				await act(async () =>
					root.render(
						<InteractionLayersProvider>
							<AppearanceProvider initialAppearance={{ proseFontSize: 18 }} initialTheme={DEFAULT_THEME}>
								<Panel />
							</AppearanceProvider>
						</InteractionLayersProvider>,
					),
				);
				assert.equal(document.querySelectorAll('[data-testid="row-prose-letter-spacing"]').length, 1);
				assert.equal(document.querySelectorAll('[data-testid="row-prose-word-spacing"]').length, 1);
				assert.equal(document.querySelectorAll('[data-testid="row-dyslexia-preset"]').length, 1);

				const presetToggle = () =>
					document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Dyslexia-friendly preset"]')!;
				assert.equal(presetToggle().getAttribute("aria-checked"), "false");
				assert.equal(document.documentElement.style.getPropertyValue("--font-prose"), "");
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-letter-spacing"), "normal");
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-word-spacing"), "normal");

				await act(async () => presetToggle().click());
				assert.equal(presetToggle().getAttribute("aria-checked"), "true");
				assert.equal(writes.at(-1)?.fontFamily, "Atkinson Hyperlegible Next");
				assert.equal(writes.at(-1)?.proseLineHeight, 1.9);
				assert.equal(writes.at(-1)?.proseLetterSpacing, 0.05);
				assert.equal(writes.at(-1)?.proseWordSpacing, 0.16);
				assert.equal(writes.at(-1)?.proseFontSize, 18);
				assert.match(document.documentElement.style.getPropertyValue("--font-prose"), /--font-atkinson/);
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-leading"), "1.9");
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-letter-spacing"), "0.05em");
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-word-spacing"), "0.16em");

				await act(async () => presetToggle().click());
				assert.equal(presetToggle().getAttribute("aria-checked"), "false");
				assert.equal(writes.at(-1)?.fontFamily, null);
				assert.equal(writes.at(-1)?.proseLineHeight, undefined);
				assert.equal(writes.at(-1)?.proseLetterSpacing, undefined);
				assert.equal(writes.at(-1)?.proseWordSpacing, undefined);
				assert.equal(document.documentElement.style.getPropertyValue("--font-prose"), "");
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-leading"), "1.65");
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-letter-spacing"), "normal");
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-word-spacing"), "normal");

				// Letter/word spacing CommitInputs clamp and persist on blur.
				const letterInput = document.querySelector<HTMLInputElement>('[data-testid="input-prose-letter-spacing"]')!;
				const wordInput = document.querySelector<HTMLInputElement>('[data-testid="input-prose-word-spacing"]')!;
				await act(async () => {
					setFormValue(letterInput, "0.08", dom, "input");
					letterInput.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
				});
				assert.equal(writes.at(-1)?.proseLetterSpacing, 0.08);
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-letter-spacing"), "0.08em");

				await act(async () => {
					setFormValue(wordInput, "0.9", dom, "input");
					wordInput.dispatchEvent(new dom.window.Event("focusout", { bubbles: true }));
				});
				assert.equal(writes.at(-1)?.proseWordSpacing, 0.4);
				assert.equal(document.documentElement.style.getPropertyValue("--lh-prose-word-spacing"), "0.4em");
			} finally {
				await act(async () => root.unmount());
			}
		});
	});
});

describe("SentenceReader local overrides & Focus spotlight", () => {
	it("inherits global tokens by default, applies Spotlight dimming, and lets Type controls override and reset without advancing sentences", async () => {
		await withDom(async (dom, sendKey) => {
			const { createRoot } = await import("react-dom/client");
			const root = createRoot(document.getElementById("root")!);
			let closed = 0;
			try {
				await act(async () =>
					root.render(
						<SentenceReader
							text="First sentence. Second sentence. Third sentence."
							onClose={() => {
								closed++;
							}}
						/>,
					),
				);

				const progress = () => document.querySelector('[data-testid="sentence-reader-progress"]')?.textContent ?? "";
				const contentDiv = () =>
					document.querySelector<HTMLElement>('[data-testid="sentence-reader"] [style*="--lh-prose-size"]')!;
				const sentences = () => [...document.querySelectorAll<HTMLElement>('[data-revealed]')];

				assert.equal(progress(), "1 / 3");
				// Inherits global tokens by default (none overridden on the reader container).
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-leading"), "");
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-letter-spacing"), "");
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-word-spacing"), "");
				assert.equal(contentDiv().style.getPropertyValue("--font-prose"), "");

				// Advance to sentence 2 via Space.
				await sendKey(" ");
				assert.equal(progress(), "2 / 3");

				// Enable Spotlight: sentence 1 dims to opacity-45 while sentence 2 stays full contrast.
				const spotlightBtn = () => document.querySelector<HTMLButtonElement>('[data-testid="sentence-reader-spotlight"]')!;
				assert.equal(spotlightBtn().getAttribute("aria-pressed"), "false");
				await act(async () => spotlightBtn().click());
				assert.equal(progress(), "2 / 3", "clicking Spotlight must not advance sentence");
				assert.equal(spotlightBtn().getAttribute("aria-pressed"), "true");
				assert.ok(sentences()[0]!.className.includes("opacity-45"), "earlier sentence dims in spotlight mode");
				assert.ok(!sentences()[1]!.className.includes("opacity-45"), "active sentence stays full contrast");
				assert.equal(sentences()[1]!.getAttribute("data-current"), "true");

				// Open Type / Dyslexia popover.
				const typeTrigger = () => document.querySelector<HTMLButtonElement>('[data-testid="sentence-reader-type-trigger"]')!;
				await act(async () => typeTrigger().click());
				assert.equal(progress(), "2 / 3");
				assert.equal(document.querySelectorAll('[data-testid="sentence-reader-type-menu"]').length, 1);

				// First Escape closes the popover without closing SentenceReader.
				await sendKey("Escape");
				assert.equal(document.querySelectorAll('[data-testid="sentence-reader-type-menu"]').length, 0);
				assert.equal(closed, 0);

				// Re-open Type popover and toggle Dyslexia-friendly mode ON, then OFF.
				await act(async () => typeTrigger().click());
				const dyslexiaBtn = () =>
					document.querySelector<HTMLButtonElement>('[data-testid="sentence-reader-dyslexia-toggle"]')!;
				// Turn spotlight off first to verify Dyslexia-friendly forces spotlight: true as well.
				await act(async () => spotlightBtn().click());
				assert.equal(spotlightBtn().getAttribute("aria-pressed"), "false");

				await act(async () => dyslexiaBtn().click());
				assert.equal(progress(), "2 / 3");
				assert.equal(dyslexiaBtn().getAttribute("aria-pressed"), "true");
				assert.equal(spotlightBtn().getAttribute("aria-pressed"), "true");
				assert.match(contentDiv().style.getPropertyValue("--font-prose"), /--font-atkinson/);
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-leading"), "1.9");
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-letter-spacing"), "0.05em");
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-word-spacing"), "0.16em");
				const storedOn = parseReaderPrefs(localStorage.getItem(READER_PREFS_KEY));
				assert.equal(storedOn.fontFamily, "Atkinson Hyperlegible Next");
				assert.equal(storedOn.spotlight, true);

				// Toggle Dyslexia-friendly back OFF -> restores inherit/off.
				await act(async () => dyslexiaBtn().click());
				assert.equal(dyslexiaBtn().getAttribute("aria-pressed"), "false");
				assert.equal(spotlightBtn().getAttribute("aria-pressed"), "false");
				assert.equal(contentDiv().style.getPropertyValue("--font-prose"), "");
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-leading"), "");
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-letter-spacing"), "");
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-word-spacing"), "");

				// Individual font select + sliders + per-slider reset.
				const fontSelect = document.querySelector<HTMLSelectElement>('[data-testid="sentence-reader-font"]')!;
				await act(async () => setFormValue(fontSelect, "Lexend", dom, "change"));
				assert.match(contentDiv().style.getPropertyValue("--font-prose"), /--font-lexend/);

				const lineSlider = document.querySelector<HTMLInputElement>('[data-testid="sentence-reader-line-height"]')!;
				await act(async () => setFormValue(lineSlider, "2.1", dom, "input"));
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-leading"), "2.1");

				const letterSlider = document.querySelector<HTMLInputElement>('[data-testid="sentence-reader-letter-spacing"]')!;
				await act(async () => setFormValue(letterSlider, "0.08", dom, "input"));
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-letter-spacing"), "0.08em");

				const wordSlider = document.querySelector<HTMLInputElement>('[data-testid="sentence-reader-word-spacing"]')!;
				await act(async () => setFormValue(wordSlider, "0.24", dom, "input"));
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-word-spacing"), "0.24em");

				const lineReset = document.querySelector<HTMLButtonElement>('[data-testid="sentence-reader-line-height-reset"]')!;
				await act(async () => lineReset.click());
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-leading"), "");

				// Reset all button clears fontFamily and spacing overrides too.
				const resetAll = document.querySelector<HTMLButtonElement>('[data-testid="sentence-reader-type-reset"]')!;
				await act(async () => resetAll.click());
				assert.equal(contentDiv().style.getPropertyValue("--font-prose"), "");
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-letter-spacing"), "");
				assert.equal(contentDiv().style.getPropertyValue("--lh-prose-word-spacing"), "");
				assert.equal(progress(), "2 / 3");

				// Backdrop click closes popover without advancing step.
				const backdrop = document.querySelector<HTMLElement>('[data-testid="sentence-reader-type-backdrop"]')!;
				await act(async () => backdrop.click());
				assert.equal(document.querySelectorAll('[data-testid="sentence-reader-type-menu"]').length, 0);
				assert.equal(progress(), "2 / 3");

				// Direct passage click while menu is open closes popover without advancing step.
				await act(async () => typeTrigger().click());
				assert.equal(document.querySelectorAll('[data-testid="sentence-reader-type-menu"]').length, 1);
				await act(async () => contentDiv().click());
				assert.equal(document.querySelectorAll('[data-testid="sentence-reader-type-menu"]').length, 0);
				assert.equal(progress(), "2 / 3");

				// Escape with popover closed calls onClose().
				await sendKey("Escape");
				assert.equal(closed, 1);
			} finally {
				await act(async () => root.unmount());
			}
		});
	});
});
