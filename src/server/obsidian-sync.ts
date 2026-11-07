/**
 * The Obsidian vault writer (fork, 2026-11-07): renders the graph
 * (core/obsidian.ts) into a vault folder on disk.
 *
 * WHERE: LH_OBSIDIAN_VAULT when set; otherwise, when Obsidian's iCloud
 * folder exists (macOS, Obsidian set to store vaults in iCloud), a
 * "LearnHarness" vault inside it, so it reaches the phone with no setup;
 * otherwise ~/Documents/LearnHarness Vault.
 *
 * SAFE TO SHARE THE FOLDER: only files this writer wrote are ever
 * changed or deleted. Their list lives in .learnharness/manifest.json; a
 * file that leaves the render (a merged-away idea) is deleted only if the
 * manifest says it is ours. A file is rewritten only when its content
 * changed, so sync services see real edits only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getGraph } from "../core/graph.ts";
import { renderVault } from "../core/obsidian.ts";
import type { GraphStore } from "../core/ports.ts";

const MANIFEST = path.join(".learnharness", "manifest.json");

export function defaultVaultDir(override: string | undefined = process.env.LH_OBSIDIAN_VAULT, home = os.homedir(), exists = fs.existsSync): string {
	if (override) return path.resolve(override);
	const icloud = path.join(home, "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents");
	if (exists(icloud)) return path.join(icloud, "LearnHarness");
	return path.join(home, "Documents", "LearnHarness Vault");
}

export interface VaultWriteResult {
	vault: string;
	notes: number;
	written: number;
	removed: number;
}

export interface ObsidianSyncDeps {
	graphStore: Pick<GraphStore, "readNodes" | "readChains">;
	topicTitle: (sourceId: string) => string | undefined;
	vaultDir?: () => string;
}

function readManifest(vault: string): string[] {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(path.join(vault, MANIFEST), "utf8"));
		return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
	} catch {
		return [];
	}
}

/** A manifest path, refused if it would leave the vault. */
function inside(vault: string, relative: string): string | null {
	const full = path.resolve(vault, relative);
	return full.startsWith(path.resolve(vault) + path.sep) ? full : null;
}

export function createObsidianSync(deps: ObsidianSyncDeps) {
	const vaultDir = deps.vaultDir ?? (() => defaultVaultDir());
	let tail: Promise<unknown> = Promise.resolve();

	function writeNow(): VaultWriteResult {
		const vault = vaultDir();
		const graph = getGraph(deps.graphStore);
		const files = renderVault({ nodes: graph.nodes, chains: graph.chains, topicTitle: deps.topicTitle });
		let written = 0;
		for (const [relative, content] of files) {
			const full = inside(vault, relative);
			if (!full) continue;
			let current: string | null = null;
			try { current = fs.readFileSync(full, "utf8"); } catch { /* new note */ }
			if (current === content) continue;
			fs.mkdirSync(path.dirname(full), { recursive: true });
			fs.writeFileSync(full, content);
			written++;
		}
		let removed = 0;
		for (const relative of readManifest(vault)) {
			if (files.has(relative)) continue;
			const full = inside(vault, relative);
			if (!full) continue;
			try { fs.unlinkSync(full); removed++; } catch { /* already gone */ }
		}
		const manifest = path.join(vault, MANIFEST);
		fs.mkdirSync(path.dirname(manifest), { recursive: true });
		fs.writeFileSync(manifest, JSON.stringify([...files.keys()].sort(), null, "\t"));
		const result = { vault, notes: files.size, written, removed };
		if (written > 0 || removed > 0) console.info(`[obsidian] ${vault}: wrote ${written}, removed ${removed} of ${files.size} notes`);
		return result;
	}

	return {
		vaultPath: () => vaultDir(),
		/** Write the vault; serialized so two triggers never interleave. */
		write(): Promise<VaultWriteResult> {
			const run = tail.catch(() => {}).then(writeNow);
			tail = run;
			return run;
		},
	};
}

export type ObsidianSync = ReturnType<typeof createObsidianSync>;
