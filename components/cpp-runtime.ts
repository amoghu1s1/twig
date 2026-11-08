import type { CodeRunRequest, CodeRunResult, CodeRuntime } from "@/src/core";

/**
 * The C++ runtime's browser half: POST the exercise to the app's own local
 * compiler route. The server owns the compiler, argv, temp files, timeouts
 * and output bounds (src/server/code-exercises.ts) — the client can only
 * name the language and supply code/tests.
 *
 * A response with a run result is a run (compile errors included). A
 * missing compiler or an unreachable route rejects, which the dock shows as
 * "runtime unavailable" — the CodeRuntime contract.
 */

function isRunResult(value: unknown): value is CodeRunResult {
	if (typeof value !== "object" || value === null) return false;
	const body = value as Record<string, unknown>;
	return (
		typeof body.stdout === "string" &&
		typeof body.timedOut === "boolean" &&
		typeof body.durationMs === "number" &&
		(body.error === undefined || typeof body.error === "string") &&
		(body.passed === undefined || typeof body.passed === "boolean")
	);
}

export function createServerCppRuntime(): CodeRuntime {
	return {
		language: "cpp",
		async run(request: CodeRunRequest): Promise<CodeRunResult> {
			let response: Response;
			try {
				response = await fetch("/api/code-exercises/run", {
					method: "POST",
					headers: { "content-type": "application/json" },
					cache: "no-store",
					body: JSON.stringify({
						language: "cpp",
						code: request.code,
						tests: request.tests,
						timeoutMs: request.timeoutMs,
					}),
				});
			} catch {
				throw new Error("Could not reach the local C++ runner.");
			}
			let body: unknown = undefined;
			try {
				body = await response.json();
			} catch {
				body = undefined;
			}
			if (!response.ok) {
				const message =
					typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
						? (body as { error: string }).error
						: `The C++ runner failed (${response.status}).`;
				throw new Error(message);
			}
			if (!isRunResult(body)) throw new Error("The C++ runner returned an invalid result.");
			return body;
		},
	};
}
