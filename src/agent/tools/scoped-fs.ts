import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { resolveSourcePath } from "./fs-shared.ts";
import { readTool } from "./read.ts";
import { lsTool } from "./ls.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";

/**
 * PROJECT-SCOPED FILE TOOLS (capstone sessions, 2026-11-01): the same
 * read-only read / ls / find / grep the other agents carry, wrapped so
 * every path argument is confined to ONE directory — the learner's
 * project, fixed when the brief was accepted. Relative paths resolve
 * against it; an absent path means the project root (not the home
 * directory); anything that resolves outside it — `..`, an absolute path,
 * a `~` path, or a symlink whose target lies outside — is refused.
 *
 * The check is on the REAL path (symlinks resolved) of the final target,
 * so a symlink inside the project cannot be used to read outside it. The
 * underlying walks (find / grep) do not follow symlinked directories, and
 * the glob/pattern arguments only match paths relative to the walked
 * root, so confining `path` confines the whole call.
 */

/** Canonicalize a project root (must exist and be a directory). Throws a
 *  plain-language Error otherwise — the brief tool surfaces the message. */
export async function resolveProjectRoot(directory: string): Promise<string> {
	const requested = directory.trim();
	if (requested.length === 0) throw new Error("the project directory is empty");
	const resolved = resolveSourcePath(requested);
	let real: string;
	try {
		real = await fs.realpath(resolved);
	} catch {
		throw new Error(`the directory "${directory}" does not exist`);
	}
	const stat = await fs.stat(real);
	if (!stat.isDirectory()) throw new Error(`"${directory}" is not a directory`);
	return real;
}

/** Resolve a tool path argument inside `root` (itself already a realpath),
 *  or throw. Exported for tests. */
export async function confineToRoot(root: string, requested: string | undefined): Promise<string> {
	let target: string;
	if (requested === undefined || requested.trim() === "" || requested === ".") target = root;
	else if (requested === "~" || requested.startsWith("~/")) target = resolveSourcePath(requested);
	else target = path.resolve(root, requested);
	let real: string;
	try {
		real = await fs.realpath(target);
	} catch {
		throw new Error(`Path not found inside the project: ${requested ?? "."}`);
	}
	if (real !== root && !real.startsWith(root + path.sep)) {
		throw new Error(`Path is outside the project directory and cannot be read: ${requested}`);
	}
	return real;
}

/** Where the project root comes from at call time: the realpath, or null
 *  while no brief has been accepted (the tools then refuse honestly). */
export type ProjectRootProvider = () => Promise<string | null>;

function scoped(tool: AgentTool<any>, getRoot: ProjectRootProvider): AgentTool<any> {
	return {
		...tool,
		description:
			`${tool.description} SCOPED to the learner's project directory (fixed when the brief is accepted): relative paths resolve ` +
			"against it, an omitted path means the project root, and nothing outside it can be read. Unavailable until the brief is accepted.",
		execute: async (toolCallId, params, signal, onUpdate) => {
			const root = await getRoot();
			if (root === null) throw new Error("No project directory yet — file access unlocks when the brief is accepted (the brief tool).");
			const input = { ...(params as Record<string, unknown>) };
			const requested = typeof input.path === "string" ? input.path : undefined;
			input.path = await confineToRoot(root, requested);
			return tool.execute(toolCallId, input, signal, onUpdate);
		},
	};
}

/** The scoped read / ls / find / grep set; the root is read at CALL time
 *  so the tools unlock in the same turn the brief is accepted. */
export function projectFsTools(getRoot: ProjectRootProvider): Record<string, AgentTool<any>> {
	return {
		read: scoped(readTool, getRoot),
		ls: scoped(lsTool, getRoot),
		find: scoped(findTool, getRoot),
		grep: scoped(grepTool, getRoot),
	};
}
