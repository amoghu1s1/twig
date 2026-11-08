/**
 * runtime-error — the one error a `CodeRuntime` may throw at the caller.
 * A rejected run means the runtime itself was unavailable (no compiler,
 * failed download, a dead sandbox); anything the learner's code did —
 * including a compile error — is a resolved `CodeRunResult`.
 */

export class CodeRuntimeError extends Error {
	override name = "CodeRuntimeError";
}
