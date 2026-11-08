/**
 * The light/system half's pure core (src/core/appearance-palette.ts): which
 * variant renders for a mode, the pre-paint System script, and the
 * theme-independent per-variant palettes used by the mode picker's
 * miniatures and the `.light` stylesheet fallback.
 *
 * The LIVE dark tokens are the active theme's (src/core/themes.ts
 * themeVars; tests/themes.test.ts pins Default against app/globals.css),
 * so this file only pins the `.light` fallback block — the dark `:root,.dark`
 * block belongs to the theme adapter's test.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import {
	MODE_DEFAULT_BACKGROUND,
	resolveRenderedMode,
	SYSTEM_MODE_SCRIPT,
	variantPalette,
} from "../src/core/appearance-palette.ts";

describe("appearance mode resolution", () => {
	it("pinned modes ignore the OS; system follows it", () => {
		assert.equal(resolveRenderedMode("dark", false), "dark");
		assert.equal(resolveRenderedMode("light", true), "light");
		assert.equal(resolveRenderedMode("system", true), "dark");
		assert.equal(resolveRenderedMode("system", false), "light");
	});

	/** Run the real pre-paint script against a fake <html> (server-rendered
	 *  class + data-lh-mode) and OS preference; returns the classes after. */
	function prePaint(lhMode: string, serverClass: string, osDark: boolean): string[] {
		const classes = new Set([serverClass]);
		const documentElement = {
			dataset: { lhMode },
			classList: { toggle: (name: string, on: boolean) => void (on ? classes.add(name) : classes.delete(name)) },
		};
		runInNewContext(SYSTEM_MODE_SCRIPT, {
			document: { documentElement },
			matchMedia: (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" && osDark }),
		});
		return [...classes].sort();
	}

	it("the pre-paint script resolves System against the OS", () => {
		assert.deepEqual(prePaint("system", "dark", false), ["light"]);
		assert.deepEqual(prePaint("system", "dark", true), ["dark"]);
	});

	it("the pre-paint script leaves pinned modes as the server rendered them", () => {
		assert.deepEqual(prePaint("dark", "dark", false), ["dark"]);
		assert.deepEqual(prePaint("light", "light", true), ["light"]);
	});

	it("the pre-paint script never throws (a missing matchMedia leaves the server class)", () => {
		const classes = new Set(["dark"]);
		const documentElement = { dataset: { lhMode: "system" }, classList: { toggle: () => classes.clear() } };
		runInNewContext(SYSTEM_MODE_SCRIPT, { document: { documentElement } });
		assert.deepEqual([...classes], ["dark"]);
	});
});

describe("variant palettes", () => {
	it("dark default reproduces the original hand-picked palette", () => {
		const p = variantPalette("dark", null);
		assert.equal(p["--background"], "#141414");
		assert.equal(p["--card"], "#1c1c1c");
		assert.equal(p["--accent"], "#2a2a2a");
		assert.equal(p["--border"], "#434343");
		assert.equal(p["--muted-foreground"], "#8d8d8d");
		assert.equal(p["--lh-line-strong"], "#ffffff");
	});

	it("light default: paper page, white raised surfaces, darker edges", () => {
		const p = variantPalette("light", null);
		assert.equal(p["--background"], MODE_DEFAULT_BACKGROUND.light);
		assert.equal(p["--card"], "#ffffff");
		assert.equal(p["--accent"], "#e8e8e6");
		assert.equal(p["--border"], "#d4d4d2");
		assert.equal(p["--foreground"], "#1a1a1a");
		assert.equal(p["--primary-foreground"], "#f5f5f3");
		assert.equal(p["--lh-line-strong"], "#1a1a1a");
	});

	it("a custom background derives along the variant's curve, clamped at 0", () => {
		const light = variantPalette("light", "#101010");
		assert.equal(light["--accent"], "#030303");
		assert.equal(light["--border"], "#000000");
		const dark = variantPalette("dark", "#202020");
		assert.equal(dark["--background"], "#202020");
		assert.equal(dark["--card"], "#282828");
		assert.equal(dark["--accent"], "#363636");
		assert.equal(dark["--border"], "#4f4f4f");
	});
});

/** The `--token: value;` declarations of the first rule whose selector is
 *  exactly `selector`, with same-block var() references resolved. */
function cssBlock(css: string, selector: string): { at: number; tokens: Record<string, string> } {
	const at = css.indexOf(`\n${selector} {`);
	assert.ok(at >= 0, `no "${selector}" block in globals.css`);
	const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("\n}", at));
	const tokens: Record<string, string> = {};
	for (const [, name, value] of body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)) tokens[name!] = value!.trim();
	for (const [k, v] of Object.entries(tokens)) {
		const ref = /^var\((--[\w-]+)\)$/.exec(v)?.[1];
		if (ref && tokens[ref]) tokens[k] = tokens[ref];
	}
	return { at, tokens };
}

describe("app/globals.css's .light fallback = variantPalette('light', null)", () => {
	const css = fs.readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
	const light = cssBlock(css, ".light");

	it("every fallback token matches (change one, change both)", () => {
		for (const [token, value] of Object.entries(variantPalette("light", null))) {
			assert.equal(light.tokens[token], value, `light ${token}`);
		}
	});

	it(".light comes after the dark block — equal specificity, so order decides", () => {
		assert.ok(light.at > css.indexOf("\n:root,"), ".light must follow the dark block");
	});
});
