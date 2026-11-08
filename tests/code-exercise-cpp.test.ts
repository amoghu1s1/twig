/**
 * Server tests — the local C++ compiler route's pure seam
 * (src/server/code-exercises.ts). No real compiler is required: a fake
 * `g++` on a fixture PATH writes the "compiled" program, so compile errors,
 * runtime failures, timeouts and temp cleanup are all deterministic. The
 * discovery test skips cleanly when the fixture is unavailable (Windows).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	CPP_MAX_TIMEOUT_MS,
	CPP_MIN_TIMEOUT_MS,
	CodeExerciseUnavailableError,
	findCppCompiler,
	parseCppRunBody,
	runCpp,
} from "../src/server/code-exercises.ts";

const FAKE_COMPILER = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
const out = argv[argv.length - 1];
const src = argv[argv.length - 3];
const text = fs.readFileSync(src, "utf8");
if (text.includes("COMPILE_FAIL")) {
  process.stderr.write("main.cpp:1:1: error: expected ';' before '}'\\n");
  process.exit(1);
}
if (!text.includes("int main")) {
  process.stderr.write("main.cpp:1:1: error: undefined reference to 'main'\\n");
  process.exit(1);
}
let script = "#!/bin/sh\\n";
if (text.includes("RUN_SLEEP")) script += "exec sleep 30\\n";
else if (text.includes("RUN_FAIL")) script += "echo 'boom' >&2\\nexit 3\\n";
else script += "echo 'hello from cpp'\\n";
fs.writeFileSync(out, script);
fs.chmodSync(out, 0o755);
`;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "twig-cpp-test-"));
const binDir = path.join(root, "bin");
const runRoot = path.join(root, "runs");
const compiler = path.join(binDir, "g++");

before(() => {
	fs.mkdirSync(binDir, { recursive: true });
	fs.mkdirSync(runRoot, { recursive: true });
	fs.writeFileSync(compiler, FAKE_COMPILER, { mode: 0o755 });
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const success = {
	code: "int add(int a, int b) { return a + b; }\n",
	tests: "int main() { return add(2, 3) == 5 ? 0 : 1; }\n",
	timeoutMs: 1000,
};

describe("findCppCompiler", () => {
	it("finds an executable compiler on PATH", { skip: process.platform === "win32" }, async () => {
		assert.equal(await findCppCompiler(binDir), compiler);
	});

	it("returns undefined when PATH has no candidate", async () => {
		const empty = path.join(root, "empty");
		fs.mkdirSync(empty, { recursive: true });
		assert.equal(await findCppCompiler(empty), undefined);
	});
});

describe("parseCppRunBody", () => {
	it("accepts a C++ request and clamps its timeout", () => {
		const parsed = parseCppRunBody({ language: "cpp", ...success, timeoutMs: 1 });
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.request.code, success.code);
		assert.equal(parsed.request.tests, success.tests);
		assert.equal(parsed.request.timeoutMs, CPP_MIN_TIMEOUT_MS);

		const high = parseCppRunBody({ language: "cpp", ...success, timeoutMs: 10_000_000 });
		assert.equal(high.ok, true);
		if (high.ok) assert.equal(high.request.timeoutMs, CPP_MAX_TIMEOUT_MS);
	});

	it("refuses other languages, blank code/tests, and oversized sources", () => {
		for (const body of [
			{ ...success, language: "python" },
			{ ...success, code: "  " },
			{ ...success, tests: " \n" },
			{ ...success, code: "x".repeat(200_001) },
			{ ...success, tests: 42 },
			null,
			[],
		]) {
			assert.equal(parseCppRunBody(body).ok, false);
		}
	});

	it("never accepts an argv/args field", () => {
		const parsed = parseCppRunBody({ language: "cpp", ...success, args: ["--evil"] });
		assert.equal(parsed.ok, true);
		if (parsed.ok) assert.equal("args" in parsed.request, false);
	});
});

describe("runCpp", () => {
	it("compiles and runs a graded exercise, then removes its temp dir", async () => {
		const result = await runCpp(success, { compiler, tempRoot: runRoot });
		assert.deepEqual(
			{ stdout: result.stdout, passed: result.passed, timedOut: result.timedOut, error: result.error },
			{ stdout: "hello from cpp\n", passed: true, timedOut: false, error: undefined },
		);
		assert.deepEqual(fs.readdirSync(runRoot), []);
	});

	it("a run-only exercise reports output without passed", async () => {
		const result = await runCpp({ code: "int main() { return 0; }", timeoutMs: 1000 }, { compiler, tempRoot: runRoot });
		assert.equal(result.stdout, "hello from cpp\n");
		assert.equal("passed" in result, false);
		assert.deepEqual(fs.readdirSync(runRoot), []);
	});

	it("returns a compile error as a failed run", async () => {
		const result = await runCpp({ ...success, code: "int main() { COMPILE_FAIL }\n" }, { compiler, tempRoot: runRoot });
		assert.match(result.error ?? "", /error:/);
		assert.equal(result.passed, false);
		assert.equal(result.timedOut, false);
		assert.deepEqual(fs.readdirSync(runRoot), []);
	});

	it("returns a nonzero program as a failed run", async () => {
		const result = await runCpp({ ...success, code: "// RUN_FAIL\nint main() { return 0; }\n" }, { compiler, tempRoot: runRoot });
		assert.match(result.error ?? "", /boom/);
		assert.equal(result.passed, false);
		assert.deepEqual(fs.readdirSync(runRoot), []);
	});

	it("kills a program that exceeds its timeout", async () => {
		const result = await runCpp(
			{ ...success, code: "// RUN_SLEEP\nint main() { return 0; }\n", timeoutMs: 100 },
			{ compiler, tempRoot: runRoot },
		);
		assert.equal(result.timedOut, true);
		assert.match(result.error ?? "", /Timed out after 100 ms/);
		assert.equal(result.passed, false);
		assert.deepEqual(fs.readdirSync(runRoot), []);
	});

	it("rejects with a clear unavailable error when no compiler exists", async () => {
		const empty = path.join(root, "empty");
		await assert.rejects(
			runCpp(success, { envPath: empty, tempRoot: runRoot }),
			(error) => error instanceof CodeExerciseUnavailableError && /No C\+\+ compiler/.test(error.message),
		);
	});
});
