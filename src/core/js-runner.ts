/**
 * js-runner — the JavaScript/TypeScript runner's wire protocol and its
 * sandboxed document. Pure strings and parsers: no DOM, no network, no
 * Node builtins, unit-testable.
 *
 * Topology (the same opaque-origin frame as the Python runner):
 *
 *   app page ──postMessage──▶ iframe sandbox="allow-scripts" (opaque origin)
 *                                 └─ classic Web Worker (data: URL)
 *
 * The learner's code and the model-authored tests never share the app's
 * origin. Each run gets a fresh Worker: a timeout terminates it, and the
 * next run cannot see globals left behind by the previous one. The Worker
 * has no DOM; fetch/XHR/WebSocket/EventSource are disabled so an exercise
 * stays local. Output is capped like the Python runner's.
 */

import type { CodeRunRequest } from "./code-exercise.ts";

/** Tags every message so unrelated postMessage traffic is ignored. */
export const JS_RUNNER_CHANNEL = "lh-js-runner";

/** Cap on captured output per run (same policy as the Python runner). */
export const JS_MAX_STDOUT_CHARS = 50_000;

// ─── protocol ───────────────────────────────────────────────────────────────

/** Host → iframe. */
export interface JsRunnerRunMessage extends CodeRunRequest {
	channel: typeof JS_RUNNER_CHANNEL;
	type: "run";
	id: number;
}

/** iframe → host. `frame-ready` fires once the iframe's script is listening;
 *  `fatal` means the runtime itself could not run request `id`; `error` in a
 *  `result` is the learner's (or a test's) thrown error. */
export type JsRunnerReply =
	| { channel: typeof JS_RUNNER_CHANNEL; type: "frame-ready" }
	| { channel: typeof JS_RUNNER_CHANNEL; type: "fatal"; id: number; message: string }
	| {
			channel: typeof JS_RUNNER_CHANNEL;
			type: "result";
			id: number;
			stdout: string;
			error?: string;
			passed?: boolean;
			timedOut: boolean;
			durationMs: number;
	  };

/** Parse an incoming window message from the iframe; undefined for anything
 *  that is not a well-formed JS runner reply. */
export function parseJsRunnerReply(data: unknown): JsRunnerReply | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const m = data as Record<string, unknown>;
	if (m.channel !== JS_RUNNER_CHANNEL) return undefined;
	if (m.type === "frame-ready") return { channel: JS_RUNNER_CHANNEL, type: "frame-ready" };
	if (typeof m.id !== "number") return undefined;
	if (m.type === "fatal") {
		const message = typeof m.message === "string" ? m.message : "unknown error";
		return { channel: JS_RUNNER_CHANNEL, type: "fatal", id: m.id, message };
	}
	if (m.type !== "result") return undefined;
	if (typeof m.stdout !== "string" || typeof m.timedOut !== "boolean" || typeof m.durationMs !== "number") {
		return undefined;
	}
	return {
		channel: JS_RUNNER_CHANNEL,
		type: "result",
		id: m.id,
		stdout: m.stdout,
		timedOut: m.timedOut,
		durationMs: m.durationMs,
		...(typeof m.error === "string" ? { error: m.error } : {}),
		...(typeof m.passed === "boolean" ? { passed: m.passed } : {}),
	};
}

// ─── the generated documents ────────────────────────────────────────────────

/** A JS string literal that is safe inside an inline <script>. */
function scriptLiteral(value: string): string {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** The Worker's source (a classic worker: no imports). It captures console
 *  output, disables network APIs, and evaluates the learner's code followed
 *  by the tests in ONE eval scope. Tests can therefore see every declaration
 *  the learner made; an `assert(condition, message)` global is provided so a
 *  failed check is a thrown error.
 *
 *  Indirect eval is deliberate: a top-level `return` is a SyntaxError there
 *  (as it is in a normal script), so it cannot silently skip the tests. */
export function buildJsWorkerSource(): string {
	return `var MAX = ${JS_MAX_STDOUT_CHARS};
var current = 0, sent = 0, truncated = false;
var rawPost = self.postMessage.bind(self);
function emit(text) {
	if (truncated) return;
	if (sent + text.length > MAX) {
		truncated = true;
		rawPost({ type: "out", id: current, text: text.slice(0, MAX - sent) + "\\n[output truncated]\\n" });
		return;
	}
	sent += text.length;
	rawPost({ type: "out", id: current, text: text });
}
function show(value) {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.name + ": " + value.message;
	if (typeof value === "undefined") return "undefined";
	if (typeof value === "function") return "[Function " + (value.name || "anonymous") + "]";
	try { return JSON.stringify(value); } catch (err) { return String(value); }
}
function formatArgs(args) { return Array.prototype.map.call(args, show).join(" "); }
var log = function () { emit(formatArgs(arguments) + "\\n"); };
console.log = log;
console.info = log;
console.debug = log;
console.warn = log;
console.error = log;
function describeError(err) {
	if (err && typeof err === "object" && typeof err.message === "string") {
		return (typeof err.name === "string" ? err.name : "Error") + ": " + err.message;
	}
	return "Thrown: " + show(err);
}
self.assert = function (condition, message) {
	if (!condition) throw new Error(message || "Assertion failed");
};
try {
	self.fetch = function () { return Promise.reject(new Error("Network access is disabled in code exercises.")); };
	self.XMLHttpRequest = undefined;
	self.WebSocket = undefined;
	self.EventSource = undefined;
	self.importScripts = undefined;
} catch (err) {}
function run(message) {
	current = message.id; sent = 0; truncated = false;
	var error, passed = message.tests === undefined ? undefined : true;
	try {
		var source = message.code;
		if (message.tests !== undefined) source += "\\n;\\n" + message.tests;
		(0, eval)(source);
	} catch (err) {
		error = describeError(err);
		if (message.tests !== undefined) passed = false;
	}
	rawPost({ type: "done", id: message.id, error: error, passed: passed });
}
self.onmessage = function (event) {
	var message = event.data;
	if (!message || message.type !== "run") return;
	run(message);
};
`;
}

/** The iframe's srcdoc. Owns the Worker lifecycle: one fresh Worker per run,
 *  a timeout terminates it, and messages are serialized. */
export function buildJsRunnerDocument(): string {
	const workerSource = buildJsWorkerSource();
	return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>(function(){
var CH = ${scriptLiteral(JS_RUNNER_CHANNEL)};
var WORKER_SOURCE = ${scriptLiteral(workerSource)};
function send(message) { message.channel = CH; parent.postMessage(message, "*"); }
function newWorker() {
	return new Worker("data:text/javascript;charset=utf-8," + encodeURIComponent(WORKER_SOURCE));
}
function execute(message) {
	return new Promise(function (resolve) {
		var worker, started = performance.now(), stdout = "", finished = false;
		function finish(extra) {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (worker) { worker.onmessage = null; worker.onerror = null; worker.terminate(); }
			resolve(Object.assign({ type: "result", id: message.id, stdout: stdout, timedOut: false, durationMs: Math.round(performance.now() - started) }, extra));
		}
		var timer = setTimeout(function () {
			finish({ timedOut: true, error: "Timed out after " + message.timeoutMs + " ms", passed: message.tests === undefined ? undefined : false });
		}, message.timeoutMs);
		try { worker = newWorker(); } catch (err) {
			finish({ error: "The JavaScript worker could not start: " + String((err && err.message) || err), passed: message.tests === undefined ? undefined : false });
			return;
		}
		worker.onmessage = function (event) {
			var d = event.data;
			if (!d || d.id !== message.id) return;
			if (d.type === "out") stdout += d.text;
			else if (d.type === "done") finish({ error: d.error, passed: d.passed });
		};
		worker.onerror = function (event) {
			var reason = (event && event.message) || "unknown error";
			finish({ error: "The JavaScript worker crashed: " + reason, passed: message.tests === undefined ? undefined : false });
		};
		worker.postMessage({ type: "run", id: message.id, code: message.code, tests: message.tests });
	});
}
var chain = Promise.resolve();
addEventListener("message", function (event) {
	var message = event.data;
	if (event.source !== parent || !message || message.channel !== CH || message.type !== "run") return;
	chain = chain.then(function () {
		return execute(message).then(send, function (err) {
			send({ type: "fatal", id: message.id, message: String((err && err.message) || err) });
		});
	});
});
send({ type: "frame-ready" });
})();</script></body></html>`;
}
