/**
 * The graph as an Obsidian vault (fork, 2026-11-07): pure rendering from
 * the derived graph to a map of vault-relative path → Markdown. The server
 * (src/server/obsidian-sync.ts) writes it to disk.
 *
 *   Home.md                 every topic, with counts
 *   Topics/<topic>.md       a hub per source: its ideas, its reasoning, and
 *                           the links that reach into other topics
 *   Ideas/<idea>.md         one Zettelkasten note per proposition: the
 *                           statement, what it follows from, what it leads
 *                           to, its topics
 *
 * Links are [[wiki links]] by file name, so Obsidian's backlinks and graph
 * view work out of the box. Names are not unique in the graph; a repeated
 * name gets its id's tail so every link stays unambiguous and stable.
 */

import type { GraphChain, GraphNode } from "./contracts.ts";

export const VAULT_IDEAS_DIR = "Ideas";
export const VAULT_TOPICS_DIR = "Topics";
export const VAULT_HOME = "Home.md";

/** A file name Obsidian (and every OS) accepts, with link-breaking
 *  characters removed. */
export function vaultFileName(text: string): string {
	const cleaned = text
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.slice(0, 100)
		.trim();
	return cleaned === "" ? "Untitled" : cleaned;
}

/** Unique names: the first holder (oldest) keeps the plain name; later
 *  holders get " (<id tail>)". Case-insensitive, like macOS file names. */
function uniqueNames<T>(items: ReadonlyArray<T>, key: (item: T) => string, base: (item: T) => string): Map<string, string> {
	const out = new Map<string, string>();
	const taken = new Set<string>();
	for (const item of items) {
		let name = vaultFileName(base(item));
		if (taken.has(name.toLowerCase())) name = `${name} (${key(item).slice(-4)})`;
		taken.add(name.toLowerCase());
		out.set(key(item), name);
	}
	return out;
}

const birth = (node: GraphNode): string => node.provenance[0]?.chatId ?? "";
const yamlString = (text: string) => JSON.stringify(text);

export interface VaultInput {
	nodes: ReadonlyArray<GraphNode>;
	chains: ReadonlyArray<GraphChain>;
	/** A source's display title; undefined hides the source (practice). */
	topicTitle: (sourceId: string) => string | undefined;
}

export function renderVault(input: VaultInput): Map<string, string> {
	const nodes = [...input.nodes]
		.filter((n) => birth(n) !== "" && input.topicTitle(birth(n)) !== undefined)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
	const byId = new Map(nodes.map((n) => [n.id, n]));
	const chains = input.chains.filter((c) => byId.has(c.conclusion) && c.premises.every((p) => byId.has(p)));

	const ideaName = uniqueNames(nodes, (n) => n.id, (n) => n.name);
	const topicIds = [...new Set(nodes.map(birth))];
	const topicName = uniqueNames(topicIds, (id) => id, (id) => input.topicTitle(id) ?? id);
	const idea = (id: string) => `[[${ideaName.get(id)}]]`;
	const topic = (sourceId: string) => `[[${VAULT_TOPICS_DIR}/${topicName.get(sourceId)}|${topicName.get(sourceId)}]]`;
	const topicsOf = (node: GraphNode) => [...new Set(node.provenance.map((p) => p.chatId))].filter((id) => topicName.has(id));
	const chainLine = (chain: GraphChain) => `${chain.premises.map(idea).join(" + ")} → ${idea(chain.conclusion)}`;

	const files = new Map<string, string>();

	for (const node of nodes) {
		const concluding = chains.filter((c) => c.conclusion === node.id);
		const serving = chains.filter((c) => c.premises.includes(node.id));
		const topics = topicsOf(node);
		const lines = [
			"---",
			`id: ${node.id}`,
			`topics: [${topics.map((t) => yamlString(`[[${VAULT_TOPICS_DIR}/${topicName.get(t)}|${topicName.get(t)}]]`)).join(", ")}]`,
			"tags: [learnharness]",
			`created: ${node.createdAt}`,
			"---",
			"",
			node.statement,
		];
		if (concluding.length > 0) {
			lines.push("", "## Follows from");
			for (const chain of concluding) lines.push(`- ${chain.premises.map(idea).join(" + ")}`);
		}
		if (serving.length > 0) {
			lines.push("", "## Leads to");
			for (const chain of serving) {
				const others = chain.premises.filter((p) => p !== node.id);
				lines.push(`- ${idea(chain.conclusion)}${others.length > 0 ? ` (with ${others.map(idea).join(" + ")})` : ""}`);
			}
		}
		const phrasings = node.aliases.filter((a) => a !== node.statement).slice(0, 5);
		if (phrasings.length > 0) {
			lines.push("", "## Also phrased");
			for (const phrasing of phrasings) lines.push(`- ${phrasing}`);
		}
		lines.push("", "## Topics", ...topics.map((t) => `- ${topic(t)}`), "");
		files.set(`${VAULT_IDEAS_DIR}/${ideaName.get(node.id)}.md`, lines.join("\n"));
	}

	for (const sourceId of topicIds) {
		const members = nodes.filter((n) => topicsOf(n).includes(sourceId));
		const memberIds = new Set(members.map((n) => n.id));
		const own = chains.filter((c) => birth(byId.get(c.conclusion)!) === sourceId);
		const reaching = own.filter((c) => c.premises.some((p) => !memberIds.has(p)));
		const lines = [`# ${topicName.get(sourceId)}`, "", "## Ideas"];
		for (const node of members) lines.push(`- ${idea(node.id)}: ${node.statement}`);
		if (own.length > 0) {
			lines.push("", "## Reasoning");
			for (const chain of own) lines.push(`- ${chainLine(chain)}`);
		}
		if (reaching.length > 0) {
			lines.push("", "## Links to other topics");
			for (const chain of reaching) {
				const elsewhere = [...new Set(chain.premises.filter((p) => !memberIds.has(p)).map((p) => birth(byId.get(p)!)))];
				lines.push(`- ${chainLine(chain)} (from ${elsewhere.map(topic).join(", ")})`);
			}
		}
		lines.push("");
		files.set(`${VAULT_TOPICS_DIR}/${topicName.get(sourceId)}.md`, lines.join("\n"));
	}

	const home = ["# Twig", "", "Written from your knowledge graph. Edits here are overwritten; add your own notes in new files.", "", "## Topics"];
	for (const sourceId of [...topicIds].sort((a, b) => (topicName.get(a) ?? "").localeCompare(topicName.get(b) ?? ""))) {
		const count = nodes.filter((n) => topicsOf(n).includes(sourceId)).length;
		home.push(`- ${topic(sourceId)} (${count} ${count === 1 ? "idea" : "ideas"})`);
	}
	home.push("");
	files.set(VAULT_HOME, home.join("\n"));
	return files;
}
