/**
 * transpiled-runtime — the small seam between a source language and the
 * JavaScript runtime it executes on (today: TypeScript → JavaScript with
 * sucrase). The transpiler is injected, so the type-stripping library stays
 * in the browser bundle and this mapping is unit-testable.
 *
 * A transpile failure is a RUN result, not a rejected runtime: the prompt
 * tells the teacher that a compile error is data. `passed` is false when the
 * exercise is graded, exactly like any other failed run.
 */

import type { CodeRunRequest, CodeRunResult, CodeLanguage, CodeRuntime } from "./code-exercise.ts";

export interface TranspiledRuntimeOptions {
	language: CodeLanguage;
	/** The runtime that executes the transpiled JavaScript. */
	base: Pick<CodeRuntime, "run">;
	/** Source → JavaScript. May throw; that is a compile error. */
	transpile: (source: string) => Promise<string> | string;
	/** Injectable clock (tests). */
	now?: () => number;
}

export function createTranspiledRuntime(options: TranspiledRuntimeOptions): CodeRuntime {
	const now = options.now ?? (() => Date.now());
	return {
		language: options.language,
		async run(request: CodeRunRequest): Promise<CodeRunResult> {
			const started = now();
			let code: string;
			let tests: string | undefined;
			try {
				code = await options.transpile(request.code);
				tests = request.tests === undefined ? undefined : await options.transpile(request.tests);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					stdout: "",
					error: `${options.language === "typescript" ? "TypeScript" : options.language} compile error: ${message}`,
					...(request.tests !== undefined ? { passed: false } : {}),
					timedOut: false,
					durationMs: Math.max(0, Math.round(now() - started)),
				};
			}
			return options.base.run({ ...request, code, tests });
		},
	};
}
