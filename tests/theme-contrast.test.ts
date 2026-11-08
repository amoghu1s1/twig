/**
 * Theme contrast law (theme wave + light/system merge): every built-in
 * preset must render its muted text and the three status inks at WCAG AA
 * for normal text (≥ 4.5:1) against BOTH the page background and the raised
 * surface. The presets' colors were tuned to this floor after the Five
 * offenders (NvChad, Pastel, Ivory, Rosé Pine Dawn, Latte) shipped under it —
 * this test pins the whole catalog so a future color edit cannot regress
 * one palette silently.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_THEMES } from "../src/core/themes.ts";

const AA_NORMAL = 4.5;

/** sRGB relative luminance for #rgb / #rrggbb (WCAG 2.1). */
function luminance(hex: string): number {
	const plain = hex.slice(1);
	const full = plain.length === 3 ? plain.split("").map((c) => c + c).join("") : plain;
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255).map((c) =>
		c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
	);
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi! + 0.05) / (lo! + 0.05);
}

const INKS = ["textMuted", "error", "success", "warning"] as const;

describe("every preset's muted/status tokens clear WCAG AA", () => {
	for (const theme of BUILTIN_THEMES) {
		it(`${theme.id} (${theme.mode})`, () => {
			for (const ink of INKS) {
				for (const surface of ["background", "surface"] as const) {
					const ratio = contrast(theme.colors[ink], theme.colors[surface]);
					assert.ok(
						ratio >= AA_NORMAL,
						`${theme.id}: ${ink} on ${surface} is ${ratio.toFixed(2)}:1 (need ≥ ${AA_NORMAL}:1)`,
					);
				}
			}
		});
	}
});
