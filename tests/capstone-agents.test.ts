/**
 * THE CAPSTONE AGENT (capstone sessions, 2026-11-01): the tool gating law
 * (one locked brief per session, verdicts cover exactly the brief's
 * criteria, gap_report only before a brief), the project-scoped file tools
 * (nothing outside the accepted directory is readable — `..`, absolute
 * paths and symlinks included), the registry shape, and the prompt
 * composition (capstone composes its own directory plus voice / accuracy /
 * formatting only).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

import { capstoneBriefOf, CAPSTONE_BRIEF_TOOL, type LhMessage } from "../src/core/native-messages.ts";
import { capstoneTools, createCapstoneGate } from "../src/agent/tools/capstone.ts";
import { confineToRoot } from "../src/agent/tools/scoped-fs.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";
import { allSegmentPaths, listSourceSegments } from "../src/agent/prompt-segments.ts";
import { isValidSegmentPath } from "../src/core/prompt-segments.ts";

// ── fixtures ─────────────────────────────────────────────────────────────────

// `realpathSync.native` also expands Windows 8.3 short names, so the
// fixture root matches what the tools return from `fs.realpath`.
const TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lh-capstone-")));
const PROJECT = path.join(TMP, "project");
const OUTSIDE = path.join(TMP, "outside");
fs.mkdirSync(path.join(PROJECT, "src"), { recursive: true });
fs.mkdirSync(OUTSIDE);
fs.writeFileSync(path.join(PROJECT, "src", "main.ts"), "export const answer = 42;\n");
fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "top secret\n");
fs.symlinkSync(path.join(OUTSIDE, "secret.txt"), path.join(PROJECT, "link.txt"));
fs.symlinkSync(OUTSIDE, path.join(PROJECT, "linkdir"));

after(() => {
	fs.rmSync(TMP, { recursive: true, force: true });
});

const STAMPS = {
	api: "faux",
	provider: "test",
	model: "test-model",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "toolUse",
} as const;

const CRITERIA = [
	{ id: "persists", text: "Saves state to a file between runs", targets: ["p1"] },
	{ id: "validates", text: "Rejects malformed input", targets: [] },
];

/** A record holding one acceptance: the brief call and its clean ack. */
function briefedRecord(directory: string, ok = true): LhMessage[] {
	const call: LhMessage & AssistantMessage = {
		id: "msg_b1",
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_b1", name: CAPSTONE_BRIEF_TOOL, arguments: { title: "Tasks", directory, criteria: CRITERIA } },
		],
		timestamp: 1,
		...STAMPS,
	};
	const result: LhMessage & ToolResultMessage = {
		id: "msg_br1",
		role: "toolResult",
		toolCallId: "call_b1",
		toolName: CAPSTONE_BRIEF_TOOL,
		content: [{ type: "text", text: ok ? "Brief recorded" : "Invalid tool input" }],
		details: null,
		isError: !ok,
		timestamp: 2,
	};
	return [call, result];
}

function toolsFor(messages: LhMessage[], graphNodes?: Array<{ id: string; name: string }>) {
	return capstoneTools({
		chatId: "c1",
		chatStore: { getChat: () => ({ messages, kind: "capstone" }) },
		...(graphNodes ? { graphNodes: () => graphNodes } : {}),
	});
}

const GRAPH = [{ id: "p1", name: "Persistence" }];
const exec = (tools: ReturnType<typeof toolsFor>, name: string, input: unknown) =>
	tools[name]!.execute("tc", input as never, undefined, undefined);
const text = (r: Awaited<ReturnType<typeof exec>>) => (r.content[0] as { text: string }).text;

const goodBrief = { title: "Tasks", directory: PROJECT, criteria: CRITERIA };
const verdicts = [
	{ criterion: "persists", status: "met", evidence: "src/main.ts:1" },
	{ criterion: "validates", status: "unmet", evidence: "no validation anywhere in src/" },
];

// ── the brief fold ───────────────────────────────────────────────────────────

describe("capstoneBriefOf", () => {
	it("reads the first CLEAN brief call", () => {
		const brief = capstoneBriefOf(briefedRecord(PROJECT));
		assert.equal(brief?.title, "Tasks");
		assert.equal(brief?.directory, PROJECT);
		assert.deepEqual(brief?.criteria.map((c) => c.id), ["persists", "validates"]);
	});

	it("ignores a brief whose result errored", () => {
		assert.equal(capstoneBriefOf(briefedRecord(PROJECT, false)), null);
	});

	it("is null for an empty record", () => {
		assert.equal(capstoneBriefOf([]), null);
	});
});

// ── the registry ─────────────────────────────────────────────────────────────

describe("capstone registry", () => {
	it("is brief + review + evaluate + gap_report + the four scoped read tools — nothing else", () => {
		assert.deepEqual(Object.keys(toolsFor([])).sort(), ["brief", "evaluate", "find", "gap_report", "grep", "ls", "read", "review"]);
	});
});

// ── brief ────────────────────────────────────────────────────────────────────

describe("brief tool", () => {
	it("records a valid brief and locks the session", async () => {
		const tools = toolsFor([], GRAPH);
		const first = await exec(tools, "brief", goodBrief);
		assert.notEqual(first.isError, true, text(first));
		assert.match(text(first), new RegExp(PROJECT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		const second = await exec(tools, "brief", goodBrief);
		assert.equal(second.isError, true);
		assert.match(text(second), /already accepted/);
	});

	it("refuses a second brief when the record already holds one", async () => {
		const r = await exec(toolsFor(briefedRecord(PROJECT)), "brief", goodBrief);
		assert.equal(r.isError, true);
	});

	it("rejects a directory that does not exist", async () => {
		const r = await exec(toolsFor([]), "brief", { ...goodBrief, directory: path.join(TMP, "nope") });
		assert.equal(r.isError, true);
		assert.match(text(r), /does not exist/);
	});

	it("rejects a directory that is a file", async () => {
		const r = await exec(toolsFor([]), "brief", { ...goodBrief, directory: path.join(PROJECT, "src", "main.ts") });
		assert.equal(r.isError, true);
		assert.match(text(r), /not a directory/);
	});

	it("rejects a blank directory instead of resolving it to home", async () => {
		const r = await exec(toolsFor([]), "brief", { ...goodBrief, directory: "   " });
		assert.equal(r.isError, true);
		assert.match(text(r), /directory is empty/);
	});

	it("rejects duplicate and non-slug criterion ids", async () => {
		const r = await exec(toolsFor([]), "brief", {
			...goodBrief,
			criteria: [{ id: "A b", text: "x" }, { id: "dup", text: "y" }, { id: "dup", text: "z" }],
		});
		assert.equal(r.isError, true);
		assert.match(text(r), /lowercase slug/);
		assert.match(text(r), /used twice/);
	});

	it("rejects unknown proposition targets", async () => {
		const r = await exec(toolsFor([], GRAPH), "brief", {
			...goodBrief,
			criteria: [{ id: "a", text: "x", targets: ["not-a-node"] }],
		});
		assert.equal(r.isError, true);
		assert.match(text(r), /not a known proposition/);
	});
});

// ── review / evaluate / gap_report ───────────────────────────────────────────

describe("review, evaluate and gap_report gates", () => {
	it("review and evaluate need an accepted brief", async () => {
		const tools = toolsFor([]);
		assert.equal((await exec(tools, "review", { verdicts, summary: "s" })).isError, true);
		assert.equal((await exec(tools, "evaluate", { verdicts, observations: "o", gaps: [] })).isError, true);
	});

	it("review accepts a verdict for every criterion", async () => {
		const r = await exec(toolsFor(briefedRecord(PROJECT)), "review", { verdicts, summary: "half done" });
		assert.notEqual(r.isError, true, text(r));
	});

	it("review rejects a missing criterion, an unknown one, and a duplicate", async () => {
		const tools = toolsFor(briefedRecord(PROJECT));
		const missing = await exec(tools, "review", { verdicts: [verdicts[0]], summary: "s" });
		assert.match(text(missing), /no verdict for criteria: validates/);
		const unknown = await exec(tools, "review", { verdicts: [...verdicts, { criterion: "ghost", status: "met", evidence: "x" }], summary: "s" });
		assert.match(text(unknown), /not a criterion of the accepted brief/);
		const dup = await exec(tools, "review", { verdicts: [...verdicts, verdicts[0]], summary: "s" });
		assert.match(text(dup), /more than one verdict/);
	});

	it("evaluate can be called again (resubmission) and validates gap targets", async () => {
		const tools = toolsFor(briefedRecord(PROJECT), GRAPH);
		const gaps = [{ area: "validation", note: "no input checks", targets: ["p1"] }];
		assert.notEqual((await exec(tools, "evaluate", { verdicts, observations: "o", gaps })).isError, true);
		assert.notEqual((await exec(tools, "evaluate", { verdicts, observations: "o2", gaps: [] })).isError, true);
		const bad = await exec(tools, "evaluate", { verdicts, observations: "o", gaps: [{ area: "a", note: "n", targets: ["zzz"] }] });
		assert.equal(bad.isError, true);
	});

	it("gap_report works with no brief and is refused once one exists", async () => {
		const gaps = [{ area: "persistence", note: "could not describe any use of it" }];
		assert.notEqual((await exec(toolsFor([]), "gap_report", { summary: "no pitch", gaps })).isError, true);
		const after = await exec(toolsFor(briefedRecord(PROJECT)), "gap_report", { summary: "no pitch", gaps });
		assert.equal(after.isError, true);
		assert.match(text(after), /already accepted/);
	});

	it("a brief accepted this turn unlocks evaluate in the same turn", async () => {
		const tools = toolsFor([], GRAPH);
		assert.equal((await exec(tools, "review", { verdicts, summary: "s" })).isError, true);
		await exec(tools, "brief", goodBrief);
		assert.notEqual((await exec(tools, "review", { verdicts, summary: "s" })).isError, true);
	});
});

// ── the scoped file tools ────────────────────────────────────────────────────

describe("project-scoped file tools", () => {
	it("refuse everything before a brief is accepted", async () => {
		await assert.rejects(exec(toolsFor([]), "read", { path: "src/main.ts" }), /No project directory yet/);
		await assert.rejects(exec(toolsFor([]), "ls", {}), /No project directory yet/);
	});

	it("read, ls, find and grep work inside the project (root seeded from the record)", async () => {
		const tools = toolsFor(briefedRecord(PROJECT));
		assert.match(text(await exec(tools, "read", { path: "src/main.ts" })), /answer = 42/);
		assert.match(text(await exec(tools, "ls", {})), /src\//);
		assert.match(text(await exec(tools, "find", { pattern: "*.ts" })), /main\.ts/);
		assert.match(text(await exec(tools, "grep", { pattern: "answer", literal: true })), /main\.ts/);
	});

	it("an absolute path inside the project is allowed", async () => {
		const tools = toolsFor(briefedRecord(PROJECT));
		assert.match(text(await exec(tools, "read", { path: path.join(PROJECT, "src", "main.ts") })), /answer = 42/);
	});

	it("refuse `..`, absolute, and ~ paths that leave the project", async () => {
		const tools = toolsFor(briefedRecord(PROJECT));
		await assert.rejects(exec(tools, "read", { path: "../outside/secret.txt" }), /outside the project/);
		await assert.rejects(exec(tools, "read", { path: path.join(OUTSIDE, "secret.txt") }), /outside the project/);
		await assert.rejects(exec(tools, "ls", { path: OUTSIDE }), /outside the project/);
		await assert.rejects(exec(tools, "grep", { pattern: "secret", path: OUTSIDE }), /outside the project/);
		await assert.rejects(exec(tools, "find", { pattern: "*", path: ".." }), /outside the project/);
		await assert.rejects(exec(tools, "read", { path: "~" }), /outside the project/);
	});

	it("refuse symlinks that point outside the project", async () => {
		const tools = toolsFor(briefedRecord(PROJECT));
		await assert.rejects(exec(tools, "read", { path: "link.txt" }), /outside the project/);
		await assert.rejects(exec(tools, "ls", { path: "linkdir" }), /outside the project/);
	});

	it("a `..` that stays inside the project is fine", async () => {
		assert.equal(await confineToRoot(PROJECT, "src/../src"), path.join(PROJECT, "src"));
	});

	it("do not leak outside content through a project-wide grep", async () => {
		const tools = toolsFor(briefedRecord(PROJECT));
		const r = await exec(tools, "grep", { pattern: "top secret", literal: true });
		assert.doesNotMatch(text(r), /top secret/);
	});
});

// ── gate seeding ─────────────────────────────────────────────────────────────

describe("createCapstoneGate", () => {
	it("seeds the brief from the record", () => {
		const gate = createCapstoneGate({ chatId: "c", chatStore: { getChat: () => ({ messages: briefedRecord(PROJECT) }) } });
		assert.equal(gate.brief?.title, "Tasks");
	});
	it("is empty for an unknown chat", () => {
		const gate = createCapstoneGate({ chatId: "c", chatStore: { getChat: () => null } });
		assert.equal(gate.brief, null);
	});
});

// ── prompt composition ───────────────────────────────────────────────────────

describe("capstone prompt composition", () => {
	it("composes only capstone/ plus voice, accuracy and formatting", () => {
		assert.deepEqual(
			listSourceSegments("capstone").map((s) => s.path),
			["capstone/00-base.md", "capstone/10-doctrine.md", "shared/10-voice.md", "shared/15-accuracy.md", "shared/40-formatting.md"],
		);
	});

	it("carries the doctrine and no teaching base", () => {
		const prompt = composeInstructions("capstone");
		assert.match(prompt, /capstone sessions/);
		assert.match(prompt, /Never design any part of the project/);
		assert.doesNotMatch(prompt, /probe/i);
	});

	it("its segment paths are valid override keys and registered", () => {
		for (const s of listSourceSegments("capstone")) {
			assert.ok(isValidSegmentPath(s.path), s.path);
			assert.ok(allSegmentPaths().includes(s.path), s.path);
		}
	});
});
