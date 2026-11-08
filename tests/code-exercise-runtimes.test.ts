/**
 * The client runtime registry: every exercise language gets a runtime of
 * its own, and repeated asks reuse the same instance (one Pyodide download,
 * one sandbox per language). Construction is lazy, so this test does not
 * touch window/Worker/Pyodide.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { codeRuntimeFor } from "../components/code-runtime.ts";
import { CODE_LANGUAGES } from "../src/core/code-exercise.ts";

describe("codeRuntimeFor", () => {
	it("returns a runtime for every language, tagged with that language", () => {
		for (const language of CODE_LANGUAGES) {
			assert.equal(codeRuntimeFor(language).language, language);
		}
	});

	it("reuses one runtime per language", () => {
		for (const language of CODE_LANGUAGES) {
			assert.equal(codeRuntimeFor(language), codeRuntimeFor(language), language);
		}
	});
});
