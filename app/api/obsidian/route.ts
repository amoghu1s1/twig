/**
 * The Obsidian vault (src/server/obsidian-sync.ts):
 *   GET   → { vault } where the vault is written
 *   POST  → write it now → VaultWriteResult
 */

import { obsidianSync } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ vault: obsidianSync.vaultPath() });
}

export async function POST() {
	try {
		return Response.json(await obsidianSync.write());
	} catch (err) {
		console.error("[obsidian] vault write failed:", err);
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}
