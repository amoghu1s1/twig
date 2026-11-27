import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { PythonEnvInfo } from "../../core/contracts/lab.ts";

const execFileAsync = promisify(execFile);

const PROBE_PACKAGES = ["numpy", "matplotlib", "torch", "pandas", "scipy", "sklearn"] as const;
const PROBE_SCRIPT = [
	"import importlib.util, json, platform",
	`pkgs = [p for p in ${JSON.stringify(PROBE_PACKAGES)} if importlib.util.find_spec(p) is not None]`,
	"print(json.dumps({'version': platform.python_version(), 'packages': pkgs}))",
].join("; ");

const ENV_CACHE_TTL_MS = 30_000;

interface EnvCacheGlobal {
	__lhPythonEnvCache?: { at: number; key: string; envs: PythonEnvInfo[] };
}

function isExecutableFile(filePath: string): boolean {
	try {
		const stat = fs.statSync(filePath);
		if (!stat.isFile()) return false;
		if (process.platform !== "win32") {
			fs.accessSync(filePath, fs.constants.X_OK);
		}
		return true;
	} catch {
		return false;
	}
}

function binCandidates(rootDir: string): string[] {
	return process.platform === "win32"
		? [path.join(rootDir, "Scripts", "python.exe"), path.join(rootDir, "python.exe")]
		: [path.join(rootDir, "bin", "python"), path.join(rootDir, "bin", "python3")];
}

interface CandidateEntry {
	path: string;
	kind: PythonEnvInfo["kind"];
	hintLabel: string;
}

function collectCandidates(opts: {
	workspaceDir?: string;
	configuredPythonPath?: string;
}): CandidateEntry[] {
	const out: CandidateEntry[] = [];
	const home = os.homedir();

	if (opts.workspaceDir) {
		for (const venvName of [".venv", "venv", "env"]) {
			const dir = path.join(/*turbopackIgnore: true*/ opts.workspaceDir, venvName);
			for (const bin of binCandidates(dir)) {
				out.push({ path: bin, kind: "workspace-venv", hintLabel: venvName });
			}
		}
	}

	if (opts.configuredPythonPath?.trim()) {
		out.push({
			path: opts.configuredPythonPath.trim(),
			kind: "custom",
			hintLabel: "configured default",
		});
	}

	if (process.env.VIRTUAL_ENV) {
		for (const bin of binCandidates(process.env.VIRTUAL_ENV)) {
			out.push({ path: bin, kind: "venv", hintLabel: path.basename(process.env.VIRTUAL_ENV) });
		}
	}
	if (process.env.CONDA_PREFIX) {
		for (const bin of binCandidates(process.env.CONDA_PREFIX)) {
			out.push({ path: bin, kind: "conda", hintLabel: `conda (${path.basename(process.env.CONDA_PREFIX)})` });
		}
	}

	// Common uv / conda / mamba / pyenv installations under home
	for (const base of ["miniforge3", "mambaforge", "miniconda3", "anaconda3"]) {
		const condaRoot = path.join(/*turbopackIgnore: true*/ home, base);
		for (const bin of binCandidates(condaRoot)) {
			out.push({ path: bin, kind: "conda", hintLabel: `${base} (base)` });
		}
		const envsDir = path.join(condaRoot, "envs");
		try {
			for (const envName of fs.readdirSync(envsDir)) {
				for (const bin of binCandidates(path.join(envsDir, envName))) {
					out.push({ path: bin, kind: "conda", hintLabel: `conda (${envName})` });
				}
			}
		} catch {
			// absent
		}
	}

	// pyenv versions
	const pyenvVersions = path.join(home, ".pyenv", "versions");
	try {
		for (const ver of fs.readdirSync(pyenvVersions)) {
			for (const bin of binCandidates(path.join(pyenvVersions, ver))) {
				out.push({ path: bin, kind: "pyenv", hintLabel: `pyenv (${ver})` });
			}
		}
	} catch {
		// absent
	}

	// uv python installs
	const uvDir = path.join(home, ".local", "share", "uv", "python");
	try {
		for (const dir of fs.readdirSync(uvDir)) {
			for (const bin of binCandidates(path.join(uvDir, dir))) {
				out.push({ path: bin, kind: "uv", hintLabel: `uv (${dir})` });
			}
		}
	} catch {
		// absent
	}

	// PATH candidates
	const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3", "python"];
	for (const dir of pathDirs) {
		for (const name of names) {
			out.push({ path: path.join(/*turbopackIgnore: true*/ dir, name), kind: "system", hintLabel: name });
		}
	}

	return out;
}

export async function probePythonInterpreter(
	executablePath: string,
	kind: PythonEnvInfo["kind"] = "custom",
	hintLabel?: string,
): Promise<PythonEnvInfo | null> {
	if (!isExecutableFile(executablePath)) return null;
	try {
		const { stdout } = await execFileAsync(executablePath, ["-I", "-c", PROBE_SCRIPT], {
			timeout: 10_000,
			maxBuffer: 64 * 1024,
			windowsHide: true,
		});
		const parsed = JSON.parse(stdout.trim()) as { version?: unknown; packages?: unknown };
		if (typeof parsed.version !== "string") return null;
		const packages = Array.isArray(parsed.packages)
			? parsed.packages.filter((p): p is string => typeof p === "string")
			: [];
		const baseLabel = hintLabel || path.basename(executablePath);
		const pkgHint = packages.length > 0 ? ` (${packages.slice(0, 3).join(", ")}${packages.length > 3 ? ", …" : ""})` : "";
		return {
			path: executablePath,
			label: `Python ${parsed.version} · ${baseLabel}${pkgHint}`,
			version: parsed.version,
			kind,
			packages,
		};
	} catch {
		return null;
	}
}

export async function discoverPythonEnvs(
	opts: { workspaceDir?: string; configuredPythonPath?: string; refresh?: boolean } = {},
): Promise<PythonEnvInfo[]> {
	const cacheKey = `${opts.workspaceDir ?? ""}::${opts.configuredPythonPath ?? ""}`;
	const g = globalThis as typeof globalThis & EnvCacheGlobal;
	if (!opts.refresh && g.__lhPythonEnvCache && g.__lhPythonEnvCache.key === cacheKey) {
		if (Date.now() - g.__lhPythonEnvCache.at < ENV_CACHE_TTL_MS) {
			return g.__lhPythonEnvCache.envs;
		}
	}

	const rawCandidates = collectCandidates(opts);
	const deduped: Array<CandidateEntry & { realpath: string }> = [];
	const seenRealpaths = new Set<string>();

	for (const c of rawCandidates) {
		if (!isExecutableFile(c.path)) continue;
		let real: string;
		try {
			real = fs.realpathSync.native(c.path);
		} catch {
			continue;
		}
		if (seenRealpaths.has(real)) continue;
		seenRealpaths.add(real);
		deduped.push({ ...c, realpath: real });
		if (deduped.length >= 16) break;
	}

	const probed = await Promise.all(
		deduped.map((c) => probePythonInterpreter(c.path, c.kind, c.hintLabel)),
	);
	const envs = probed.filter((item): item is PythonEnvInfo => item !== null);
	g.__lhPythonEnvCache = { at: Date.now(), key: cacheKey, envs };
	return envs;
}

export async function resolveDefaultPython(opts: {
	workspaceDir?: string;
	configuredPythonPath?: string;
	explicitInterpreterPath?: string;
} = {}): Promise<string | null> {
	if (opts.explicitInterpreterPath?.trim()) {
		const probed = await probePythonInterpreter(opts.explicitInterpreterPath.trim(), "custom");
		if (probed) return probed.path;
	}
	const envs = await discoverPythonEnvs({
		workspaceDir: opts.workspaceDir,
		configuredPythonPath: opts.configuredPythonPath,
	});
	return envs[0]?.path ?? null;
}
