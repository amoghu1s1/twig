import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getAntigravityBinary } from "./binary.ts";
import { inspectAntigravityVersion, readAntigravityVersion, type ReadAntigravityVersion } from "./installation.ts";

export class AntigravityLaunchError extends Error {}

export type RunAntigravityOptions = {
	cwd: string;
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
};

export type AntigravityChild = ChildProcessWithoutNullStreams | null;
export type RunAntigravity = (args: string[], options: RunAntigravityOptions) => AntigravityChild | Promise<AntigravityChild>;

export const ANTIGRAVITY_ACP_ARGS = ["acp", "--stdio", "--include-default-customizations=false"] as const;

/** Injectable seams keep all verification offline; production uses the installed CLI. */
export function createAntigravityLauncher({
	findBinary = getAntigravityBinary,
	readVersion = readAntigravityVersion,
	spawnProcess = spawn,
}: {
	findBinary?: () => string | null;
	readVersion?: ReadAntigravityVersion;
	spawnProcess?: typeof spawn;
} = {}): RunAntigravity {
	return async (args, options) => {
		if (options.signal?.aborted) throw new AntigravityLaunchError("Request was aborted");
		const binary = findBinary();
		if (!binary) return null;
		const status = await inspectAntigravityVersion(() => binary, readVersion);
		if (status.state === "update-required") {
			throw new AntigravityLaunchError(
				`Antigravity CLI ${status.version} requires an update. Twig requires at least ${status.minimumVersion}; update agy outside Twig.`,
			);
		}
		if (status.state !== "meets-minimum") {
			throw new AntigravityLaunchError(
				"Antigravity CLI's version could not be checked. Check your installation outside Twig and try again.",
			);
		}
		if (options.signal?.aborted) throw new AntigravityLaunchError("Request was aborted");
		return spawnProcess(binary, args, { cwd: options.cwd, env: options.env, stdio: "pipe", windowsHide: true });
	};
}
