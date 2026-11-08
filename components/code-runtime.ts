import { createTranspiledRuntime, type CodeLanguage, type CodeRunRequest, type CodeRunResult, type CodeRuntime } from "@/src/core";
import { createBrowserPythonRuntime } from "@/components/python-runtime-iframe";
import { createBrowserJsRuntime } from "@/components/js-runtime-iframe";
import { createServerCppRuntime } from "@/components/cpp-runtime";
import { transpileTypeScript } from "@/components/typescript-transpile";

/** Pyodide ships with the app: public/pyodide/ (scripts/copy-pyodide.mjs),
 *  served by the app's own server. Absolute, because the runner's worker
 *  lives in an opaque-origin iframe where a relative URL resolves to nothing. */
const pyodideIndexUrl = (): string => `${window.location.origin}/pyodide/`;

const runtimes = new Map<CodeLanguage, CodeRuntime>();

/** A runtime whose browser backend is built on first use — the dock also
 *  renders on the server, where there is no `window` to resolve the app
 *  origin from. */
function lazyRuntime(language: CodeLanguage, open: () => CodeRuntime): CodeRuntime {
	let runtime: CodeRuntime | undefined;
	return {
		language,
		run: (request: CodeRunRequest): Promise<CodeRunResult> => {
			runtime ??= open();
			return runtime.run(request);
		},
	};
}

function createRuntime(language: CodeLanguage): CodeRuntime {
	switch (language) {
		case "python":
			return lazyRuntime(language, () => createBrowserPythonRuntime(pyodideIndexUrl()));
		case "javascript":
			return lazyRuntime(language, () => createBrowserJsRuntime("javascript"));
		case "typescript": {
			// TypeScript shares the JavaScript sandbox: strip the types in
			// the browser, then run the resulting program through the same
			// opaque-origin Worker protocol.
			let javascript: CodeRuntime | undefined;
			return createTranspiledRuntime({
				language,
				base: {
					run: (request) => {
						javascript ??= createBrowserJsRuntime("javascript");
						return javascript.run(request);
					},
				},
				transpile: transpileTypeScript,
			});
		}
		case "cpp":
			return createServerCppRuntime();
	}
}

/** The shared runtime for a language. One per page: the sandbox (and, for
 *  Python, the Pyodide download) is created on the first run and reused by
 *  every exercise. */
export function codeRuntimeFor(language: CodeLanguage): CodeRuntime {
	let runtime = runtimes.get(language);
	if (!runtime) {
		runtime = createRuntime(language);
		runtimes.set(language, runtime);
	}
	return runtime;
}
