/**
 * code-exercises — the local C++ compiler seam behind
 * POST /api/code-exercises/run.
 *
 * Security shape (owner requirement, multi-language wave):
 *   - the compiler is discovered on PATH (clang++, then g++) and invoked
 *     with a FIXED argv: `-std=c++20 -O0 -pipe <src> -o <bin>`;
 *   - nothing from the request becomes an argv element or a shell word —
 *     `shell: false` and stdin is closed;
 *   - code and tests live in a fresh mkdtemp directory, removed in finally;
 *   - compile and run are time-limited, output is bounded, and the run
 *     inherits no extra arguments.
 *
 * A compile error, a thrown/nonzero program and a timeout are all resolved
 * `CodeRunResult`s (the learner's data); only a missing compiler / failed
 * spawn rejects, as CodeExerciseUnavailableError.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { CodeRunResult } from "../core/code-exercise.ts";

/** Compiler preference order; both speak the fixed argv below. */
export const CPP_COMPILER_CANDIDATES = ["clang++", "g++"] as const;

/** Per-stream output cap (the same 50k policy as the browser runners). */
export const CPP_MAX_OUTPUT_CHARS = 50_000;

/** Code + tests may not exceed this; the route rejects larger bodies. */
export const CPP_MAX_SOURCE_CHARS = 200_000;

/** Compilation is local and fixed; it gets its own generous deadline. */
export const CPP_COMPILE_TIMEOUT_MS = 20_000;

/** Bounds on a learner run's timeout (the dock asks for 10 s). */
export const CPP_MIN_TIMEOUT_MS = 100;
export const CPP_MAX_TIMEOUT_MS = 20_000;
export const CPP_DEFAULT_TIMEOUT_MS = 10_000;

/** The runtime itself (compiler/binary) could not start. */
export class CodeExerciseUnavailableError extends Error {
	override name = "CodeExerciseUnavailableError";
}

export interface CppRunRequest {
	code: string;
	tests?: string;
	timeoutMs: number;
}

export type CppRunBodyParse = { ok: true; request: CppRunRequest } | { ok: false; error: string };

function clampTimeout(value: number): number {
	if (!Number.isFinite(value)) return CPP_DEFAULT_TIMEOUT_MS;
	return Math.min(CPP_MAX_TIMEOUT_MS, Math.max(CPP_MIN_TIMEOUT_MS, Math.round(value)));
}

/** Validate the route body. Only `language: "cpp"` reaches the compiler;
 *  every other language is a client bug (the browser owns those runtimes). */
export function parseCppRunBody(body: unknown): CppRunBodyParse {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		return { ok: false, error: "Expected a JSON object." };
	}
	const raw = body as Record<string, unknown>;
	if (raw.language !== "cpp") return { ok: false, error: 'Only language "cpp" uses the local compiler route.' };
	if (typeof raw.code !== "string" || raw.code.trim().length === 0) {
		return { ok: false, error: "code must be a non-empty string." };
	}
	let tests: string | undefined;
	if (raw.tests !== undefined) {
		if (typeof raw.tests !== "string") return { ok: false, error: "tests must be a string when present." };
		if (raw.tests.trim().length === 0) {
			return { ok: false, error: "tests is blank — omit it for a run-only exercise." };
		}
		tests = raw.tests;
	}
	if (raw.code.length + (tests?.length ?? 0) > CPP_MAX_SOURCE_CHARS) {
		return { ok: false, error: `code + tests is too long (max ${CPP_MAX_SOURCE_CHARS} characters).` };
	}
	const timeoutMs = typeof raw.timeoutMs === "number" ? clampTimeout(raw.timeoutMs) : CPP_DEFAULT_TIMEOUT_MS;
	return { ok: true, request: { code: raw.code, ...(tests !== undefined ? { tests } : {}), timeoutMs } };
}

/** Look for clang++ then g++ along PATH. Returns the absolute executable
 *  path, or undefined. Exported so tests can point it at a fixture PATH. */
export async function findCppCompiler(
	envPath: string = process.env.PATH ?? "",
	platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
	const dirs = envPath.split(path.delimiter).filter((dir) => dir.length > 0);
	for (const name of CPP_COMPILER_CANDIDATES) {
		const files = platform === "win32" ? [`${name}.exe`, name] : [name];
		for (const dir of dirs) {
			for (const file of files) {
				const candidate = path.join(dir, file);
				try {
					await fs.access(candidate, constants.X_OK);
					return candidate;
				} catch {
					/* keep looking */
				}
			}
		}
	}
	return undefined;
}

interface ProcessOutcome {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
	spawnError?: Error;
}

/** Run one process with no shell, closed stdin, a deadline and bounded
 *  output. Overflow kills the process and marks the stream truncated. */
function runProcess(
	command: string,
	args: readonly string[],
	options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<ProcessOutcome> {
	return new Promise<ProcessOutcome>((resolve) => {
		const stdout = { text: "", truncated: false };
		const stderr = { text: "", truncated: false };
		let settled = false;
		let timedOut = false;
		let child: ChildProcess;
		try {
			child = spawn(command, [...args], {
				cwd: options.cwd,
				env: options.env,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			resolve({
				code: null,
				signal: null,
				stdout: "",
				stderr: "",
				timedOut: false,
				truncated: false,
				spawnError: error instanceof Error ? error : new Error(String(error)),
			});
			return;
		}

		const sink = (target: { text: string; truncated: boolean }) => (chunk: Buffer | string) => {
			if (target.truncated) return;
			const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			const room = CPP_MAX_OUTPUT_CHARS - target.text.length;
			if (text.length > room) {
				target.text += text.slice(0, Math.max(0, room)) + "\n[output truncated]\n";
				target.truncated = true;
				child.kill("SIGKILL");
				return;
			}
			target.text += text;
		};
		child.stdout?.on("data", sink(stdout));
		child.stderr?.on("data", sink(stderr));

		const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code,
				signal,
				stdout: stdout.text,
				stderr: stderr.text,
				timedOut,
				truncated: stdout.truncated || stderr.truncated,
				...(spawnError ? { spawnError } : {}),
			});
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		child.on("error", (error) => finish(null, null, error));
		child.on("close", (code, signal) => finish(code, signal));
	});
}

/** Keep compiler diagnostics readable and server paths out of the card. */
function stripDirectory(text: string, directory: string): string {
	return text.split(directory + path.sep).join("").split(directory).join("");
}

/** Compiler diagnostics: strip paths and the trailing blank lines. */
function cleanError(text: string, directory: string): string {
	return stripDirectory(text, directory).trimEnd();
}

/** The child gets only what a toolchain needs: PATH to find its own
 *  helpers, and a writable temp/home inside the exercise's directory. The
 *  server's other environment (API keys, session paths) never reaches the
 *  compiler or the compiled program. */
function childEnvironment(directory: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "",
		NODE_ENV: process.env.NODE_ENV ?? "production",
		HOME: directory,
		TMPDIR: directory,
		TEMP: directory,
		TMP: directory,
	};
}

export interface CppRunOptions {
	/** Skip PATH discovery (tests / a caller-pinned compiler). */
	compiler?: string;
	/** PATH used only for compiler discovery. */
	envPath?: string;
	platform?: NodeJS.Platform;
	/** Parent for the temp directory (tests assert cleanup). */
	tempRoot?: string;
}

/** Compile + run one C++ exercise/tests translation unit. */
export async function runCpp(request: CppRunRequest, options: CppRunOptions = {}): Promise<CodeRunResult> {
	const compiler = options.compiler ?? (await findCppCompiler(options.envPath, options.platform));
	if (!compiler) {
		throw new CodeExerciseUnavailableError(
			"No C++ compiler was found on PATH — install clang++ or g++ to run C++ exercises.",
		);
	}

	const started = Date.now();
	const timeoutMs = clampTimeout(request.timeoutMs);
	const tempRoot = options.tempRoot ?? os.tmpdir();
	const directory = await fs.mkdtemp(path.join(tempRoot, "twig-cpp-"));
	const sourcePath = path.join(directory, "main.cpp");
	const binaryPath = path.join(directory, process.platform === "win32" ? "exercise.exe" : "exercise");
	const graded = request.tests !== undefined;
	const duration = (): number => Date.now() - started;

	try {
		// The tests are appended to the SAME translation unit: they can call
		// the learner's functions directly, and C++'s one-main rule means the
		// tests provide `main` (the prompt says so).
		const source = `${request.code}\n${request.tests !== undefined ? `\n${request.tests}\n` : ""}`;
		await fs.writeFile(sourcePath, source, "utf8");

		const compile = await runProcess(
			compiler,
			["-std=c++20", "-O0", "-pipe", sourcePath, "-o", binaryPath],
			{ cwd: directory, timeoutMs: CPP_COMPILE_TIMEOUT_MS, env: childEnvironment(directory) },
		);
		if (compile.spawnError) {
			throw new CodeExerciseUnavailableError(`The C++ compiler could not start: ${compile.spawnError.message}`);
		}
		if (compile.timedOut) {
			return {
				stdout: stripDirectory(compile.stdout, directory),
				error: `Compilation timed out after ${CPP_COMPILE_TIMEOUT_MS} ms`,
				...(graded ? { passed: false } : {}),
				timedOut: true,
				durationMs: duration(),
			};
		}
		if (compile.code !== 0) {
			const detail = cleanError(compile.stderr, directory) || cleanError(compile.stdout, directory);
			return {
				stdout: stripDirectory(compile.stdout, directory),
				error: detail || `Compilation failed (exit ${compile.code ?? "by signal"}).`,
				...(graded ? { passed: false } : {}),
				timedOut: false,
				durationMs: duration(),
			};
		}

		const run = await runProcess(binaryPath, [], { cwd: directory, timeoutMs, env: childEnvironment(directory) });
		if (run.spawnError) {
			throw new CodeExerciseUnavailableError(`The compiled C++ program could not start: ${run.spawnError.message}`);
		}
		const programStdout = stripDirectory(run.stdout, directory);
		const programStderr = stripDirectory(run.stderr, directory);
		if (run.timedOut) {
			return {
				// Whatever was printed before the kill is still useful.
				stdout: programStdout + programStderr,
				error: `Timed out after ${timeoutMs} ms`,
				...(graded ? { passed: false } : {}),
				timedOut: true,
				durationMs: duration(),
			};
		}
		if (run.code !== 0) {
			return {
				stdout: programStdout,
				error:
					cleanError(run.stderr, directory) ||
					`Program exited with code ${run.code ?? "unknown"}${run.signal ? ` (${run.signal})` : ""}.`,
				...(graded ? { passed: false } : {}),
				timedOut: false,
				durationMs: duration(),
			};
		}
		return {
			// A successful program's stderr is diagnostic output, like Python's.
			stdout: programStdout + programStderr,
			...(graded ? { passed: true } : {}),
			timedOut: false,
			durationMs: duration(),
		};
	} finally {
		await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
	}
}
