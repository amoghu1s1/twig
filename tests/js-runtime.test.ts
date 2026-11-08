/**
 * Unit tests — js-runtime (the host side, against a fake transport): request
 * correlation, results/errors, the timeout watchdog and disposal.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJsRuntime, type JsRunnerTransport } from "../src/core/js-runtime.ts";
import { JS_RUNNER_CHANNEL as CH, type JsRunnerReply, type JsRunnerRunMessage } from "../src/core/js-runner.ts";
import { CodeRuntimeError } from "../src/core/runtime-error.ts";

type ReplyBody = RunnerBody<JsRunnerReply>;
type RunnerBody<T> = T extends { channel: unknown } ? Omit<T, "channel"> : never;

function fakeTransport() {
	const posted: JsRunnerRunMessage[] = [];
	const listeners = new Set<(reply: JsRunnerReply) => void>();
	let closed = false;
	const transport: JsRunnerTransport = {
		post: (message) => void posted.push(message),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close: () => {
			closed = true;
		},
	};
	const reply = (r: ReplyBody) => {
		for (const listener of listeners) listener({ channel: CH, ...r } as JsRunnerReply);
	};
	return { transport, posted, reply, isClosed: () => closed, listenerCount: () => listeners.size };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const request = { code: "console.log(1)", timeoutMs: 1000 };

describe("createJsRuntime", () => {
	it("opens the frame lazily and posts only after frame-ready", async () => {
		const frame = fakeTransport();
		let opened = 0;
		const runtime = createJsRuntime({ language: "javascript", openTransport: () => (opened++, frame.transport) });
		assert.equal(opened, 0);
		const run = runtime.run(request);
		await tick();
		assert.equal(opened, 1);
		assert.equal(frame.posted.length, 0);
		frame.reply({ type: "frame-ready" });
		await tick();
		assert.equal(frame.posted.length, 1);
		assert.equal(frame.posted[0]!.code, request.code);
		frame.reply({ type: "result", id: frame.posted[0]!.id, stdout: "1\n", timedOut: false, durationMs: 7 });
		assert.deepEqual(await run, { stdout: "1\n", timedOut: false, durationMs: 7 });
		runtime.dispose();
	});

	it("carries an error and passed through", async () => {
		const frame = fakeTransport();
		const runtime = createJsRuntime({ language: "typescript", openTransport: () => frame.transport });
		const run = runtime.run({ ...request, tests: "assert(false, 'x')" });
		frame.reply({ type: "frame-ready" });
		await tick();
		frame.reply({ type: "result", id: frame.posted[0]!.id, stdout: "", error: "Error: x", passed: false, timedOut: false, durationMs: 2 });
		const result = await run;
		assert.equal(result.error, "Error: x");
		assert.equal(result.passed, false);
		runtime.dispose();
	});

	it("passes a timeout result through without a watchdog failure", async () => {
		const frame = fakeTransport();
		const runtime = createJsRuntime({ language: "javascript", openTransport: () => frame.transport, watchdogGraceMs: 1000 });
		const run = runtime.run({ ...request, tests: "assert(true, 'ok')" });
		frame.reply({ type: "frame-ready" });
		await tick();
		frame.reply({ type: "result", id: frame.posted[0]!.id, stdout: "partial\n", error: "Timed out after 1000 ms", passed: false, timedOut: true, durationMs: 1000 });
		assert.deepEqual(await run, {
			stdout: "partial\n",
			error: "Timed out after 1000 ms",
			passed: false,
			timedOut: true,
			durationMs: 1000,
		});
		runtime.dispose();
	});

	it("rejects only the affected run on fatal", async () => {
		const frame = fakeTransport();
		const runtime = createJsRuntime({ language: "javascript", openTransport: () => frame.transport });
		const a = runtime.run(request);
		const b = runtime.run(request);
		frame.reply({ type: "frame-ready" });
		await tick();
		const [first, second] = frame.posted as [JsRunnerRunMessage, JsRunnerRunMessage];
		frame.reply({ type: "fatal", id: first.id, message: "worker failed to start" });
		frame.reply({ type: "result", id: second.id, stdout: "ok", timedOut: false, durationMs: 1 });
		await assert.rejects(a, (error) => error instanceof CodeRuntimeError && /worker failed/.test(error.message));
		assert.equal((await b).stdout, "ok");
		runtime.dispose();
	});

	it("resets a silent frame: rejects in-flight runs and reopens", async () => {
		const frames = [fakeTransport(), fakeTransport()];
		let opened = 0;
		const runtime = createJsRuntime({ language: "javascript", openTransport: () => frames[opened++]!.transport, watchdogGraceMs: 20 });
		const stuck = runtime.run({ ...request, timeoutMs: 10 });
		frames[0]!.reply({ type: "frame-ready" });
		await assert.rejects(stuck, (error) => error instanceof CodeRuntimeError && /stopped responding/.test(error.message));
		assert.equal(frames[0]!.isClosed(), true);
		assert.equal(frames[0]!.listenerCount(), 0);

		const next = runtime.run(request);
		await tick();
		assert.equal(opened, 2);
		frames[1]!.reply({ type: "frame-ready" });
		await tick();
		frames[1]!.reply({ type: "result", id: frames[1]!.posted[0]!.id, stdout: "back", timedOut: false, durationMs: 1 });
		assert.equal((await next).stdout, "back");
		runtime.dispose();
	});

	it("dispose rejects in-flight runs and closes the frame", async () => {
		const frame = fakeTransport();
		const runtime = createJsRuntime({ language: "javascript", openTransport: () => frame.transport });
		const run = runtime.run(request);
		frame.reply({ type: "frame-ready" });
		await tick();
		runtime.dispose();
		await assert.rejects(run, CodeRuntimeError);
		assert.equal(frame.isClosed(), true);
	});
});
