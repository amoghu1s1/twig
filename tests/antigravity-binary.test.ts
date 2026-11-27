import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAntigravityBinary } from "../src/agent/antigravity/binary.ts";

test("discovers agy from PATH first on POSIX", () => {
	const found = resolveAntigravityBinary({
		env: { PATH: "/custom/bin:/usr/bin" },
		platform: "linux",
		homeDir: "/home/tester",
		cwd: "/work",
		isExecutable: (p) => p === "/custom/bin/agy" || p === "/home/tester/.local/bin/agy",
	});
	assert.equal(found, "/custom/bin/agy");
});

test("falls back to mise shims and known install locations when PATH omits agy", () => {
	const found = resolveAntigravityBinary({
		env: { PATH: "/usr/bin" },
		platform: "linux",
		homeDir: "/home/tester",
		cwd: "/work",
		isExecutable: (p) => p === "/home/tester/.local/share/mise/shims/agy",
	});
	assert.equal(found, "/home/tester/.local/share/mise/shims/agy");
});

test("requires agy.exe directly on Windows and ignores .cmd wrappers", () => {
	const missing = resolveAntigravityBinary({
		env: { PATH: "C:\\tools" },
		platform: "win32",
		homeDir: "C:\\Users\\tester",
		cwd: "C:\\work",
		isExecutable: (p) => p.endsWith("agy.cmd"),
	});
	assert.equal(missing, null);

	const found = resolveAntigravityBinary({
		env: { PATH: "C:\\tools" },
		platform: "win32",
		homeDir: "C:\\Users\\tester",
		cwd: "C:\\work",
		isExecutable: (p) => p === "C:\\tools\\agy.exe",
	});
	assert.equal(found, "C:\\tools\\agy.exe");
});
