/**
 * Unit tests — transpiled-runtime: TypeScript is stripped with the real
 * sucrase transform, then handed to the JavaScript runtime. Compile errors
 * are run results; a run error/timeout passes through unchanged.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createTranspiledRuntime } from "../src/core/transpiled-runtime.ts";
import type { CodeRunRequest, CodeRunResult } from "../src/core/code-exercise.ts";
import { transpileTypeScript } from "../components/typescript-transpile.ts";

describe("createTranspiledRuntime (TypeScript → JavaScript)", () => {
	it("strips types from code and tests, then runs them", async () => {
		let seen: CodeRunRequest | undefined;
		const base: { run: (request: CodeRunRequest) => Promise<CodeRunResult> } = {
			run: async (request) => {
				seen = request;
				return { stdout: "ran\n", passed: true, timedOut: false, durationMs: 1 };
			},
		};
		const runtime = createTranspiledRuntime({ language: "typescript", base, transpile: transpileTypeScript });
		const result = await runtime.run({
			code: "const total: number = 2 + 3;\nconsole.log(total);",
			tests: "const expected: number = 5;\nassert(total === expected, 'total');",
			timeoutMs: 1000,
		});
		assert.equal(result.stdout, "ran\n");
		assert.equal(result.passed, true);
		assert.ok(seen);
		assert.doesNotMatch(seen.code, /: number/);
		assert.doesNotMatch(seen.tests ?? "", /: number/);
		assert.match(seen.code, /const total = 2 \+ 3/);
	});

	it("reports a TypeScript syntax error as a failed run", async () => {
		let called = false;
		const runtime = createTranspiledRuntime({
			language: "typescript",
			base: {
				run: async () => {
					called = true;
					return { stdout: "", timedOut: false, durationMs: 1 };
				},
			},
			transpile: transpileTypeScript,
			now: (() => {
				let t = 0;
				return () => (t += 5);
			})(),
		});
		const result = await runtime.run({ code: "const n: number = ;", tests: "assert(true, 'ok');", timeoutMs: 1000 });
		assert.equal(called, false, "a compile error never reaches the JavaScript runtime");
		assert.match(result.error ?? "", /^TypeScript compile error:/);
		assert.equal(result.passed, false);
		assert.equal(result.timedOut, false);
		assert.equal(result.durationMs, 5);
	});

	it("passes a runtime error and a timeout through", async () => {
		const errored = createTranspiledRuntime({
			language: "typescript",
			base: { run: async () => ({ stdout: "", error: "Error: boom", passed: false, timedOut: false, durationMs: 2 }) },
			transpile: (source) => source,
		});
		assert.deepEqual(await errored.run({ code: "throw new Error('boom')", tests: "assert(true, 'ok')", timeoutMs: 1000 }), {
			stdout: "",
			error: "Error: boom",
			passed: false,
			timedOut: false,
			durationMs: 2,
		});

		const timedOut = createTranspiledRuntime({
			language: "typescript",
			base: { run: async () => ({ stdout: "partial", error: "Timed out after 10 ms", passed: false, timedOut: true, durationMs: 10 }) },
			transpile: (source) => source,
		});
		const result = await timedOut.run({ code: "while (true) {}", tests: "assert(true, 'ok')", timeoutMs: 10 });
		assert.equal(result.timedOut, true);
		assert.equal(result.passed, false);
	});
});
