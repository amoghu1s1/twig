// Cross-platform test launcher. The old `NODE_ENV=test tsx --test …` script
// only works under a POSIX shell; Windows cmd treats the assignment as a
// command. This also enumerates the test files itself, so no shell glob is
// required and the command line stays short on Windows.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = path.join(root, "tests");
const files = readdirSync(testsDir)
	.filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.tsx"))
	.sort()
	.map((name) => path.join("tests", name));

const nodeOptions = `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=2048`.trim();

const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
	cwd: root,
	stdio: "inherit",
	env: { ...process.env, NODE_ENV: "test", NODE_OPTIONS: nodeOptions },
});
child.on("error", (error) => {
	console.error("[test] failed to start:", error);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) {
		console.error(`[test] interrupted by ${signal}`);
		process.exit(1);
	}
	process.exit(code ?? 1);
});
