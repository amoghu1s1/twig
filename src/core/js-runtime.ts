/**
 * js-runtime — the host side of the JavaScript/TypeScript runner: a
 * `CodeRuntime` that talks to the sandboxed iframe (js-runner.ts) through
 * an injected transport. The transport is the only browser-specific piece
 * (components/js-runtime-iframe.ts), so request correlation, queueing, the
 * watchdog and error mapping run under test.
 *
 * `run` resolves for anything the code did (errors, failed asserts and
 * timeouts are results). It rejects with CodeRuntimeError only when the
 * runtime itself is unavailable: the frame never started, it went silent,
 * or it was disposed. TypeScript is transpiled before this layer sees the
 * request (see transpiled-runtime.ts).
 */

import type { CodeRunRequest, CodeRunResult, CodeLanguage, CodeRuntime } from "./code-exercise.ts";
import { JS_RUNNER_CHANNEL, type JsRunnerReply, type JsRunnerRunMessage } from "./js-runner.ts";
import { CodeRuntimeError } from "./runtime-error.ts";

/** One live JS runner frame. */
export interface JsRunnerTransport {
	post(message: JsRunnerRunMessage): void;
	/** Deliver parsed replies from this frame; returns the unsubscribe. */
	subscribe(listener: (reply: JsRunnerReply) => void): () => void;
	/** Tear the frame down. */
	close(): void;
}

export interface JsRuntimeOptions {
	language: Extract<CodeLanguage, "javascript" | "typescript">;
	/** Create a fresh frame. Called lazily on the first run, and again after a reset. */
	openTransport: () => JsRunnerTransport;
	/** How long past a run's own timeout (and for the frame to announce
	 *  itself) the host waits before declaring the frame dead. Default 30 s. */
	watchdogGraceMs?: number;
}

export interface JsRuntime extends CodeRuntime {
	language: "javascript" | "typescript";
	/** Tear the frame down and reject anything in flight. */
	dispose(): void;
}

interface Pending {
	resolve: (result: CodeRunResult) => void;
	reject: (error: CodeRuntimeError) => void;
	watchdog: ReturnType<typeof setTimeout>;
}

interface Session {
	transport: JsRunnerTransport;
	unsubscribe: () => void;
	ready: Promise<void>;
	markReady: () => void;
	failReady: (error: CodeRuntimeError) => void;
	readyWatchdog: ReturnType<typeof setTimeout>;
}

export function createJsRuntime(options: JsRuntimeOptions): JsRuntime {
	const grace = options.watchdogGraceMs ?? 30_000;
	const name = options.language === "typescript" ? "TypeScript" : "JavaScript";
	const pending = new Map<number, Pending>();
	let session: Session | null = null;
	let nextId = 0;

	function toResult(reply: Extract<JsRunnerReply, { type: "result" }>): CodeRunResult {
		return {
			stdout: reply.stdout,
			timedOut: reply.timedOut,
			durationMs: reply.durationMs,
			...(reply.error !== undefined ? { error: reply.error } : {}),
			...(reply.passed !== undefined ? { passed: reply.passed } : {}),
		};
	}

	function onReply(reply: JsRunnerReply): void {
		if (reply.type === "frame-ready") {
			if (session) {
				clearTimeout(session.readyWatchdog);
				session.markReady();
			}
			return;
		}
		const entry = pending.get(reply.id);
		if (!entry) return;
		pending.delete(reply.id);
		clearTimeout(entry.watchdog);
		if (reply.type === "fatal") entry.reject(new CodeRuntimeError(reply.message));
		else entry.resolve(toResult(reply));
	}

	/** Close the frame and reject everything waiting on it. */
	function reset(error: CodeRuntimeError): void {
		const closing = session;
		session = null;
		if (closing) {
			clearTimeout(closing.readyWatchdog);
			closing.unsubscribe();
			closing.transport.close();
			closing.failReady(error);
		}
		for (const entry of pending.values()) {
			clearTimeout(entry.watchdog);
			entry.reject(error);
		}
		pending.clear();
	}

	function openSession(): Session {
		const transport = options.openTransport();
		let markReady!: () => void;
		let failReady!: (error: CodeRuntimeError) => void;
		const ready = new Promise<void>((resolve, reject) => {
			markReady = resolve;
			failReady = reject;
		});
		ready.catch(() => {}); // a reset with nobody waiting is not an unhandled rejection
		return {
			transport,
			unsubscribe: transport.subscribe(onReply),
			ready,
			markReady,
			failReady,
			readyWatchdog: setTimeout(
				() => reset(new CodeRuntimeError(`The ${name} runtime frame never started.`)),
				grace,
			),
		};
	}

	return {
		language: options.language,

		async run(request: CodeRunRequest): Promise<CodeRunResult> {
			const current = (session ??= openSession());
			await current.ready;
			if (session !== current) throw new CodeRuntimeError(`The ${name} runtime was reset.`);
			return new Promise<CodeRunResult>((resolve, reject) => {
				const id = ++nextId;
				const watchdog = setTimeout(
					() => reset(new CodeRuntimeError(`The ${name} runtime stopped responding.`)),
					request.timeoutMs + grace,
				);
				pending.set(id, { resolve, reject, watchdog });
				current.transport.post({ channel: JS_RUNNER_CHANNEL, type: "run", id, ...request });
			});
		},

		dispose(): void {
			reset(new CodeRuntimeError(`The ${name} runtime was disposed.`));
		},
	};
}
