/**
 * Unit tests — js-runner: the wire protocol, the generated documents, and
 * the Worker source itself executed in a Node VM (no browser, no network).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
	buildJsRunnerDocument,
	buildJsWorkerSource,
	JS_RUNNER_CHANNEL as CH,
	parseJsRunnerReply,
} from "../src/core/js-runner.ts";

interface WorkerMessage {
	type: string;
	id?: number;
	text?: string;
	error?: string;
	passed?: boolean;
}

/** Execute the real Worker source in a minimal worker-like global. */
function runInWorker(request: { code: string; tests?: string; timeoutMs?: number }): WorkerMessage[] {
	const posted: WorkerMessage[] = [];
	const sandbox: Record<string, unknown> = {
		console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
		setTimeout,
		clearTimeout,
		postMessage() {
			throw new Error("the Worker must use its captured postMessage");
		},
	};
	sandbox.self = sandbox;
	(sandbox as { self: Record<string, unknown> }).self.postMessage = (message: WorkerMessage) => void posted.push(message);
	vm.createContext(sandbox);
	vm.runInContext(buildJsWorkerSource(), sandbox);
	const self = (sandbox as { self: { onmessage: (event: { data: unknown }) => void } }).self;
	self.onmessage({ data: { type: "run", id: 1, timeoutMs: 1000, ...request } });
	return posted;
}

const stdoutOf = (messages: readonly WorkerMessage[]): string =>
	messages.filter((m) => m.type === "out").map((m) => m.text ?? "").join("");
const doneOf = (messages: readonly WorkerMessage[]): WorkerMessage | undefined =>
	messages.find((m) => m.type === "done");

describe("parseJsRunnerReply", () => {
	it("parses frame-ready, fatal and result", () => {
		assert.deepEqual(parseJsRunnerReply({ channel: CH, type: "frame-ready" }), { channel: CH, type: "frame-ready" });
		assert.deepEqual(parseJsRunnerReply({ channel: CH, type: "fatal", id: 3, message: "boom" }), {
			channel: CH,
			type: "fatal",
			id: 3,
			message: "boom",
		});
		assert.deepEqual(
			parseJsRunnerReply({ channel: CH, type: "result", id: 1, stdout: "hi\n", timedOut: false, durationMs: 4, passed: true }),
			{ channel: CH, type: "result", id: 1, stdout: "hi\n", timedOut: false, durationMs: 4, passed: true },
		);
	});

	it("drops undefined optional fields a structured clone leaves behind", () => {
		const reply = parseJsRunnerReply({
			channel: CH, type: "result", id: 1, stdout: "", timedOut: false, durationMs: 1, error: undefined, passed: undefined,
		});
		assert.ok(reply && reply.type === "result");
		assert.equal("error" in reply, false);
		assert.equal("passed" in reply, false);
	});

	it("ignores foreign and malformed messages", () => {
		assert.equal(parseJsRunnerReply(null), undefined);
		assert.equal(parseJsRunnerReply("x"), undefined);
		assert.equal(parseJsRunnerReply({ type: "frame-ready" }), undefined);
		assert.equal(parseJsRunnerReply({ channel: "other", type: "frame-ready" }), undefined);
		assert.equal(parseJsRunnerReply({ channel: CH, type: "result", id: 1 }), undefined);
		assert.equal(parseJsRunnerReply({ channel: CH, type: "nope", id: 1 }), undefined);
	});
});

describe("the JS Worker executes the learner's code", () => {
	it("captures console output and passes tests that see the code's declarations", () => {
		const messages = runInWorker({
			code: "const total = 2 + 3;\nconsole.log('total', total);\nconsole.log('second');",
			tests: "assert(total === 5, 'total should be 5');",
		});
		assert.equal(stdoutOf(messages), "total 5\nsecond\n");
		const done = doneOf(messages);
		assert.equal(done?.error, undefined);
		assert.equal(done?.passed, true);
	});

	it("reports a thrown error and fails the graded run", () => {
		const messages = runInWorker({ code: "throw new Error('boom');", tests: "assert(true, 'ok');" });
		assert.equal(stdoutOf(messages), "");
		assert.equal(doneOf(messages)?.error, "Error: boom");
		assert.equal(doneOf(messages)?.passed, false);
	});

	it("reports a failed assertion with its message", () => {
		const messages = runInWorker({ code: "const x = 1;", tests: "assert(x === 2, 'x should be 2');" });
		assert.equal(doneOf(messages)?.error, "Error: x should be 2");
		assert.equal(doneOf(messages)?.passed, false);
	});

	it("omits passed for a run-only exercise", () => {
		const messages = runInWorker({ code: "console.log('hi');" });
		assert.equal(stdoutOf(messages), "hi\n");
		assert.equal(doneOf(messages)?.passed, undefined);
	});

	it("treats a top-level return as a syntax error, so it cannot skip the tests", () => {
		const messages = runInWorker({ code: "return;", tests: "assert(false, 'tests must run');" });
		assert.match(doneOf(messages)?.error ?? "", /SyntaxError/);
		assert.equal(doneOf(messages)?.passed, false);
	});

	it("does not expose the network", () => {
		const messages = runInWorker({
			code: "console.log(typeof XMLHttpRequest, typeof WebSocket, typeof EventSource);",
		});
		assert.equal(stdoutOf(messages), "undefined undefined undefined\n");
	});
});

describe("the generated JS runner document", () => {
	it("worker source is valid JavaScript and carries the protocol", () => {
		const source = buildJsWorkerSource();
		assert.doesNotThrow(() => new Function(source));
		assert.match(source, /self\.onmessage/);
		assert.match(source, /self\.assert/);
	});

	it("the document is a sandbox-safe page with one valid script", () => {
		const doc = buildJsRunnerDocument();
		const scripts = [...doc.matchAll(/<script>([\s\S]*?)<\/script>/g)];
		assert.equal(scripts.length, 1);
		assert.equal(doc.split("</script>").length, 2, "no stray </script> from embedded strings");
		assert.doesNotThrow(() => new Function(scripts[0]![1]!));
		assert.ok(doc.includes(CH));
	});
});
