import { Worker } from "node:worker_threads";

/**
 * Model-supplied regular expressions, run safely (security hardening,
 * ported from the jacobderechin fork, 2026-11-08). A catastrophic-
 * backtracking pattern ("(a+)+$" over a long line) blocks the event loop
 * synchronously — no timeout can interrupt it in-thread, so one grep or
 * pdf_search could freeze the whole server. The pattern therefore runs in a
 * worker thread with a time budget per tool call; when the budget runs out
 * the worker is terminated and the model gets a "pattern too slow" error.
 * Literal searches never come here (an escaped pattern is linear).
 */

export const MAX_PATTERN_LENGTH = 1000;
export const REGEX_BUDGET_MS = 5_000;

export class RegexTooSlowError extends Error {
	constructor(budgetMs: number) {
		super(`Search pattern is too slow (exceeded ${budgetMs / 1000}s) — simplify the regex or search literally.`);
	}
}

/** Escape a literal search string into a (linear) pattern. */
export function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Length + syntax gate, in-thread (compiling is cheap; matching is not). */
export function checkPattern(pattern: string, flags?: string): void {
	if (pattern.length > MAX_PATTERN_LENGTH) throw new Error(`Search pattern is too long (max ${MAX_PATTERN_LENGTH} characters).`);
	try {
		new RegExp(pattern, flags);
	} catch (err) {
		throw new Error(`Invalid regex: ${(err as Error).message}`);
	}
}

// Plain CommonJS on purpose: evaluated as the worker's script, no imports.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const re = new RegExp(workerData.pattern, workerData.flags);
parentPort.on("message", ({ id, lines }) => {
	const hits = [];
	for (let i = 0; i < lines.length; i++) {
		re.lastIndex = 0;
		if (re.test(lines[i])) hits.push(i);
	}
	parentPort.postMessage({ id, hits });
});
`;

/** One tool call's regex: a worker plus a shared deadline. Always close(). */
export class RegexScanner {
	readonly #worker: Worker;
	readonly #deadline: number;
	readonly #budgetMs: number;
	#next = 0;

	constructor(pattern: string, flags: string | undefined, budgetMs = REGEX_BUDGET_MS) {
		checkPattern(pattern, flags);
		this.#budgetMs = budgetMs;
		this.#deadline = Date.now() + budgetMs;
		this.#worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { pattern, flags } });
		this.#worker.unref();
	}

	/** Indices of the lines that match; rejects with RegexTooSlowError once
	 *  the call's budget is spent (the worker is terminated). */
	matchLines(lines: string[]): Promise<number[]> {
		const id = ++this.#next;
		const remaining = this.#deadline - Date.now();
		if (remaining <= 0) {
			void this.#worker.terminate();
			return Promise.reject(new RegexTooSlowError(this.#budgetMs));
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				void this.#worker.terminate();
				reject(new RegexTooSlowError(this.#budgetMs));
			}, remaining);
			const onMessage = (message: { id: number; hits: number[] }) => {
				if (message.id !== id) return;
				cleanup();
				resolve(message.hits);
			};
			const onError = (err: Error) => {
				cleanup();
				reject(err);
			};
			const cleanup = () => {
				clearTimeout(timer);
				this.#worker.off("message", onMessage);
				this.#worker.off("error", onError);
			};
			this.#worker.on("message", onMessage);
			this.#worker.on("error", onError);
			this.#worker.postMessage({ id, lines });
		});
	}

	close(): void {
		void this.#worker.terminate();
	}
}
