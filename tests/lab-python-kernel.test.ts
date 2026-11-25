import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { LabStreamEvent } from "../src/core/index.ts";
import { discoverPythonEnvs, resolveDefaultPython } from "../src/server/lab/python-envs.ts";
import { PythonLabKernel } from "../src/server/lab/python-kernel.ts";

const TMP_DIR = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lh-lab-kernel-")));

after(() => {
	fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("python-kernel + env discovery", async () => {
	const pythonPath = await resolveDefaultPython();

	it("discovers local Python 3 interpreters", async () => {
		const envs = await discoverPythonEnvs({ refresh: true });
		assert.ok(envs.length >= 1, "expected at least one Python interpreter");
		assert.ok(envs[0]?.version.startsWith("3."), `expected Python 3.x, got ${envs[0]?.version}`);
	});

	it("runs cells in a persistent namespace, streams stdout/stderr, and evaluates trailing expressions", async () => {
		assert.ok(pythonPath, "python3 must be available for kernel integration tests");
		const kernel = new PythonLabKernel({ interpreterPath: pythonPath, cwd: TMP_DIR });
		try {
			await kernel.start();
			assert.equal(kernel.status(), "idle");

			// Write a helper module into workspace to verify sys.path includes cwd
			fs.writeFileSync(path.join(TMP_DIR, "local_helper.py"), "def greet(name):\n    return f'hello {name}'\n", "utf-8");

			const events1: LabStreamEvent[] = [];
			const res1 = await kernel.execute(
				{ cellId: "c1", role: "code", code: "from local_helper import greet\nx = 21\nprint('loading', flush=True)\ngreet('twig')" },
				(e) => events1.push(e),
			);
			assert.equal(res1.status, "ok");
			assert.equal(res1.executionCount, 1);
			assert.ok(events1.some((e) => e.type === "stream" && e.name === "stdout" && e.text.includes("loading")));
			assert.ok(events1.some((e) => e.type === "output" && e.output.outputType === "execute_result" && e.output.data["text/plain"] === "'hello twig'"));

			// Second cell reads x from persistent namespace
			const events2: LabStreamEvent[] = [];
			const res2 = await kernel.execute(
				{ cellId: "c2", role: "code", code: "y = x * 2\ny" },
				(e) => events2.push(e),
			);
			assert.equal(res2.status, "ok");
			assert.equal(res2.executionCount, 2);
			assert.ok(events2.some((e) => e.type === "output" && e.output.outputType === "execute_result" && e.output.data["text/plain"] === "42"));

			const vars = await kernel.inspectVars();
			const names = new Set(vars.map((v) => v.name));
			assert.ok(names.has("x"));
			assert.ok(names.has("y"));
		} finally {
			await kernel.shutdown();
		}
	});

	it("runs Check cells evaluating all assertions independently and reports per-case failures", async () => {
		assert.ok(pythonPath);
		const kernel = new PythonLabKernel({ interpreterPath: pythonPath, cwd: TMP_DIR });
		try {
			await kernel.execute({ cellId: "setup", role: "code", code: "a = 10\nb = 5" }, () => {});

			const passEvents: LabStreamEvent[] = [];
			await kernel.execute(
				{ cellId: "chk1", role: "check", code: "assert a == 10\nassert b == 5" },
				(e) => passEvents.push(e),
			);
			const passResult = passEvents.find((e) => e.type === "check_result");
			assert.ok(passResult?.type === "check_result");
			assert.equal(passResult.result.passed, true);
			assert.equal(passResult.result.checkPassed, true);
			assert.equal(passResult.result.status, "passed");
			assert.equal(passResult.result.passedCount, 2);
			assert.equal(passResult.result.totalCount, 2);
			assert.equal(passResult.result.cases?.length, 2);

			const failEvents: LabStreamEvent[] = [];
			await kernel.execute(
				{ cellId: "chk2", role: "check", code: "assert a == 10\nassert b == 99, 'b should be 99'\nassert a + b == 15" },
				(e) => failEvents.push(e),
			);
			const failResult = failEvents.find((e) => e.type === "check_result");
			assert.ok(failResult?.type === "check_result");
			assert.equal(failResult.result.passed, false);
			assert.equal(failResult.result.checkPassed, false);
			assert.equal(failResult.result.status, "failed");
			assert.equal(failResult.result.passedCount, 2);
			assert.equal(failResult.result.totalCount, 3);
			assert.equal(failResult.result.cases?.length, 3);
			assert.equal(failResult.result.cases?.[0]?.passed, true);
			assert.equal(failResult.result.cases?.[1]?.passed, false);
			assert.equal(failResult.result.cases?.[2]?.passed, true);
			assert.match(failResult.result.summary, /2\/3 checks passed.*b should be 99/);
		} finally {
			await kernel.shutdown();
		}
	});

	it("auto-reloads edited workspace .py modules without losing kernel variables", async () => {
		assert.ok(pythonPath);
		const modFile = path.join(TMP_DIR, "reload_demo.py");
		fs.writeFileSync(modFile, "def compute(x):\n    return x + 1\n", "utf-8");

		const kernel = new PythonLabKernel({ interpreterPath: pythonPath, cwd: TMP_DIR });
		try {
			await kernel.start();
			const ev1: LabStreamEvent[] = [];
			await kernel.execute(
				{ cellId: "r1", role: "code", code: "from reload_demo import compute\nbase = 10\ncompute(base)" },
				(e) => ev1.push(e),
			);
			assert.ok(ev1.some((e) => e.type === "output" && e.output.outputType === "execute_result" && e.output.data["text/plain"] === "11"));

			// Ensure filesystem mtime_ns visibly advances, then edit reload_demo.py
			await new Promise((r) => setTimeout(r, 30));
			fs.writeFileSync(modFile, "def compute(x):\n    return x * 10\n", "utf-8");
			const future = new Date(Date.now() + 2000);
			fs.utimesSync(modFile, future, future);

			const ev2: LabStreamEvent[] = [];
			const sum2 = await kernel.execute(
				{ cellId: "r2", role: "code", code: "compute(base)" },
				(e) => ev2.push(e),
			);
			assert.equal(sum2.status, "ok");
			assert.ok(sum2.reloadedModules?.includes("reload_demo.py"));
			assert.ok(ev2.some((e) => e.type === "stream" && e.text.includes("[auto-reloaded: reload_demo.py]")));
			assert.ok(ev2.some((e) => e.type === "output" && e.output.outputType === "execute_result" && e.output.data["text/plain"] === "100"));
		} finally {
			await kernel.shutdown();
		}
	});

	it("interrupts an infinite loop with SIGINT without losing existing namespace, and restart clears state", async () => {
		assert.ok(pythonPath);
		const kernel = new PythonLabKernel({ interpreterPath: pythonPath, cwd: TMP_DIR });
		try {
			await kernel.execute({ cellId: "init", role: "code", code: "kept_value = 'still here'" }, () => {});

			const loopEvents: LabStreamEvent[] = [];
			const execPromise = kernel.execute(
				{ cellId: "loop", role: "code", code: "import time\nprint('started', flush=True)\nwhile True:\n    time.sleep(0.05)" },
				(e) => loopEvents.push(e),
			);

			// Wait until 'started' stream arrives before sending SIGINT
			await new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + 4000;
				const poll = () => {
					if (loopEvents.some((e) => e.type === "stream" && e.text.includes("started"))) return resolve();
					if (Date.now() > deadline) return reject(new Error("Loop cell never emitted startup print"));
					setTimeout(poll, 20);
				};
				poll();
			});

			await kernel.interrupt();
			const loopSummary = await execPromise;
			assert.equal(loopSummary.status, "interrupted");

			// Existing variable survived SIGINT
			const checkEvents: LabStreamEvent[] = [];
			const afterInterrupt = await kernel.execute({ cellId: "after", role: "code", code: "kept_value" }, (e) => checkEvents.push(e));
			assert.equal(afterInterrupt.status, "ok");
			assert.ok(checkEvents.some((e) => e.type === "output" && e.output.outputType === "execute_result" && e.output.data["text/plain"] === "'still here'"));

			// Restart clears namespace
			await kernel.restart();
			const postRestartEvents: LabStreamEvent[] = [];
			const postRestart = await kernel.execute({ cellId: "post", role: "code", code: "kept_value" }, (e) => postRestartEvents.push(e));
			assert.equal(postRestart.status, "error");
			assert.ok(postRestartEvents.some((e) => e.type === "output" && e.output.outputType === "error" && e.output.outputType === "error" && e.output.ename === "NameError"));
		} finally {
			await kernel.shutdown();
		}
	});
});
