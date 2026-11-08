/**
 * The graph as an Obsidian vault (fork, 2026-11-07):
 *   core/obsidian.ts           notes, hubs, home, unique names, links
 *   server/obsidian-sync.ts    writes a temp vault, rewrites only changes,
 *                              deletes only its own files; vault location
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { GraphChain, GraphNode } from "../src/core/contracts.ts";
import { renderVault, vaultFileName } from "../src/core/obsidian.ts";
import { createObsidianSync, defaultVaultDir } from "../src/server/obsidian-sync.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lh-vault-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function node(id: string, name: string, statement: string, chatId: string, createdAt = "2026-11-01T00:00:00.000Z"): GraphNode {
	return { id, name, statement, aliases: [], createdAt, provenance: [{ chatId, messageId: "m1" }] };
}

const NODES = [
	node("n_wid", "West India Docks", "The West India Docks opened in 1802.", "docks"),
	node("n_merch", "West India merchants", "West India merchants financed the docks.", "docks"),
	node("n_abol", "Abolition", "Britain abolished colonial slavery in 1834.", "sligo"),
	node("n_link", "Compensation and the docks", "Compensation reached the dock financiers.", "docks", "2026-11-02T00:00:00.000Z"),
	node("n_dup", "Abolition", "A different idea with the same name.", "sligo", "2026-11-03T00:00:00.000Z"),
];
const CHAINS: GraphChain[] = [
	{ id: "arg_1", premises: ["n_wid"], conclusion: "n_merch", createdAt: "x", provenance: [] },
	{ id: "arg_2", premises: ["n_abol", "n_merch"], conclusion: "n_link", createdAt: "x", provenance: [] },
];
const titles: Record<string, string> = { docks: "London Docklands", sligo: "Marquis of Sligo" };
const render = (nodes = NODES, chains = CHAINS) => renderVault({ nodes, chains, topicTitle: (id) => titles[id] });

describe("core/obsidian", () => {
	it("makes safe, unique file names", () => {
		assert.equal(vaultFileName("A/B: C? [x]"), "A B C x");
		assert.equal(vaultFileName("  "), "Untitled");
		const files = render();
		assert.ok(files.has("Ideas/Abolition.md"));
		assert.ok(files.has("Ideas/Abolition (_dup).md"));
	});

	it("writes an idea note with its reasoning both ways and its topics", () => {
		const merch = render().get("Ideas/West India merchants.md")!;
		assert.match(merch, /^---\nid: n_merch\n/);
		assert.match(merch, /West India merchants financed the docks\./);
		assert.match(merch, /## Follows from\n- \[\[West India Docks\]\]/);
		assert.match(merch, /## Leads to\n- \[\[Compensation and the docks\]\] \(with \[\[Abolition\]\]\)/);
		assert.match(merch, /- \[\[Topics\/London Docklands\|London Docklands\]\]/);
	});

	it("writes topic hubs that show links into other topics, and a home page", () => {
		const files = render();
		const docks = files.get("Topics/London Docklands.md")!;
		assert.match(docks, /## Ideas\n/);
		assert.match(docks, /- \[\[West India Docks\]\]: The West India Docks opened/);
		assert.match(docks, /## Reasoning\n[^]*\[\[West India Docks\]\] → \[\[West India merchants\]\]/);
		assert.match(docks, /## Links to other topics\n- \[\[Abolition\]\] \+ \[\[West India merchants\]\] → \[\[Compensation and the docks\]\] \(from \[\[Topics\/Marquis of Sligo\|Marquis of Sligo\]\]\)/);
		assert.match(files.get("Home.md")!, /\[\[Topics\/London Docklands\|London Docklands\]\] \(3 ideas\)/);
	});

	it("leaves out ideas whose topic is hidden", () => {
		const files = renderVault({ nodes: NODES, chains: CHAINS, topicTitle: (id) => (id === "docks" ? "Docks" : undefined) });
		assert.ok(!files.has("Ideas/Abolition.md"));
		assert.ok(!files.get("Ideas/West India merchants.md")!.includes("Compensation"));
	});
});

describe("server/obsidian-sync", () => {
	it("writes, rewrites only changes, and deletes only its own notes", async () => {
		const vault = path.join(tmp, "vault");
		let nodes = NODES;
		const sync = createObsidianSync({ graphStore: { readNodes: () => nodes, readChains: () => CHAINS }, topicTitle: (id) => titles[id], vaultDir: () => vault });
		const first = await sync.write();
		assert.equal(first.written, first.notes);
		fs.writeFileSync(path.join(vault, "Ideas", "My own note.md"), "mine");
		const second = await sync.write();
		assert.equal(second.written, 0);
		nodes = NODES.filter((n) => n.id !== "n_dup");
		const third = await sync.write();
		assert.equal(third.removed, 1);
		assert.ok(!fs.existsSync(path.join(vault, "Ideas", "Abolition (_dup).md")));
		assert.equal(fs.readFileSync(path.join(vault, "Ideas", "My own note.md"), "utf8"), "mine");
	});

	it("picks the vault: env, then Obsidian's iCloud folder, then Documents", () => {
		assert.equal(defaultVaultDir("/v", "/h", () => true), path.resolve("/v"));
		assert.equal(defaultVaultDir(undefined, "/h", () => true), path.join("/h", "Library", "Mobile Documents", "iCloud~md~obsidian", "Documents", "Twig"));
		assert.equal(defaultVaultDir(undefined, "/h", () => false), path.join("/h", "Documents", "Twig Vault"));
	});
});
