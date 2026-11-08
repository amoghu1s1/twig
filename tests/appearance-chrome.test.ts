/**
 * The desktop shell's appearance handling (electron/appearance-chrome.cjs):
 * what the renderer's lh:appearance payload (or settings.json) becomes, the
 * themeSource per mode, the native colors per rendered variant, and which
 * settings.json the shell reads at launch. One appearance system: mode
 * (dark/light/system) picks the variant, the active theme supplies the
 * background — so the custom background wins in EVERY variant.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, it } from "node:test";

const require = createRequire(import.meta.url);
const { normalizeAppearance, themeSourceFor, chromeColors, serverDataDir, WINDOW_CHROME } = require("../electron/appearance-chrome.cjs");

describe("normalizeAppearance", () => {
	it("keeps a valid mode and hex background", () => {
		assert.deepEqual(normalizeAppearance({ mode: "system", background: "#202020" }), { mode: "system", background: "#202020" });
		assert.deepEqual(normalizeAppearance({ mode: "light", background: "#abc" }), { mode: "light", background: "#abc" });
	});

	it("junk falls back to the dark factory, and unknown fields drop", () => {
		for (const junk of [null, undefined, "dark", 42, { mode: "sepia", background: "red" }, { background: { evil: 1 } }]) {
			assert.deepEqual(normalizeAppearance(junk), { mode: "dark", background: null });
		}
		assert.deepEqual(normalizeAppearance({ mode: "dark", lightBackground: "#eeeeee" }), { mode: "dark", background: null });
	});
});

describe("themeSourceFor", () => {
	it("pins the explicit mode; system follows the OS", () => {
		assert.equal(themeSourceFor("dark"), "dark");
		assert.equal(themeSourceFor("light"), "light");
		assert.equal(themeSourceFor("system"), "system");
		// Unknown input is the dark factory, never an Electron-invalid value.
		assert.equal(themeSourceFor("sepia"), "dark");
	});
});

describe("chromeColors", () => {
	const dark = { color: WINDOW_CHROME.dark.background, symbolColor: WINDOW_CHROME.dark.symbol };
	const light = { color: WINDOW_CHROME.light.background, symbolColor: WINDOW_CHROME.light.symbol };

	it("pinned modes ignore the OS", () => {
		assert.deepEqual(chromeColors({ mode: "dark", background: null }, false), dark);
		assert.deepEqual(chromeColors({ mode: "light", background: null }, true), light);
	});

	it("system takes the OS's variant", () => {
		assert.deepEqual(chromeColors({ mode: "system", background: null }, true), dark);
		assert.deepEqual(chromeColors({ mode: "system", background: null }, false), light);
	});

	it("the reported theme background wins in every rendered variant", () => {
		assert.equal(chromeColors({ mode: "dark", background: "#202020" }, false).color, "#202020");
		assert.equal(chromeColors({ mode: "light", background: "#faf4ed" }, true).color, "#faf4ed");
		assert.equal(chromeColors({ mode: "system", background: "#202020" }, true).color, "#202020");
		assert.equal(chromeColors({ mode: "system", background: "#faf4ed" }, false).color, "#faf4ed");
	});
});

describe("serverDataDir", () => {
	const base = { packagedDataDir: "/userData/data", repoRoot: "/repo" };

	it("packaged: the dir handed to the server child", () => {
		assert.equal(serverDataDir({ ...base, devUrl: undefined, env: { LH_DATA_DIR: "/elsewhere" } }), "/userData/data");
	});

	it("dev: mirrors config.ts — LH_DATA_DIR, else the repo's data/", () => {
		assert.equal(serverDataDir({ ...base, devUrl: "http://localhost:3000", env: {} }), path.join("/repo", "data"));
		assert.equal(serverDataDir({ ...base, devUrl: "http://localhost:3000", env: { LH_DATA_DIR: "/tmp/lh" } }), path.resolve("/tmp/lh"));
	});
});
