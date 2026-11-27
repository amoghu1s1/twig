import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { afterEach, test } from "node:test";
import type { Api, AssistantMessage, Message, Model, Tool } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { Type } from "typebox";
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "../src/agent/antigravity/constants.ts";
import { killAllLiveProcesses } from "../src/agent/antigravity/live-processes.ts";
import { createAntigravityStreamFunction } from "../src/agent/antigravity/stream.ts";

afterEach(() => {
	killAllLiveProcesses();
});

const TEST_MODEL: Model<Api> = {
	id: "gemini-3.8-flash",
	name: "Gemini 3.8 Flash",
	api: ANTIGRAVITY_API,
	provider: ANTIGRAVITY_PROVIDER,
	baseUrl: "",
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
	contextWindow: 1_048_576,
	maxTokens: 65_536,
};

const ECHO_TOOL: Tool = {
	name: "twig_echo",
	description: "Echo a value",
	parameters: Type.Object({ msg: Type.String() }),
};

/** Spawns a tiny inline Node script acting as a synthetic `agy acp` stdio server. */
function spawnFakeAcp(scriptBody: string) {
	return spawn(process.execPath, ["-e", scriptBody], { stdio: "pipe" });
}

test("streams thinking, text, usage, cliContextWindow, and passes _meta.antigravity.systemPrompt.append", async () => {
	const fakeScript = `
		const readline = require("readline");
		const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");
		let appendedPrompt = "";
		let selectedModel = "";
		let selectedThought = "";
		readline.createInterface({ input: process.stdin }).on("line", (line) => {
			if (!line.trim()) return;
			const msg = JSON.parse(line);
			if (msg.method === "initialize") {
				send({ id: msg.id, result: { protocolVersion: 1, agentInfo: { name: "Fake", version: "1.5.18" } } });
			} else if (msg.method === "session/new") {
				appendedPrompt = msg.params?._meta?.antigravity?.systemPrompt?.append || "";
				send({ id: msg.id, result: { sessionId: "acp-1" } });
				send({ method: "session/update", params: { sessionId: "acp-1", update: { sessionUpdate: "usage_update", used: 0, size: 512000 } } });
			} else if (msg.method === "session/set_config_option") {
				if (msg.params.configId === "model") selectedModel = msg.params.value;
				if (msg.params.configId === "thought_level") selectedThought = msg.params.value;
				send({ id: msg.id, result: { configOptions: [] } });
			} else if (msg.method === "session/prompt") {
				send({ method: "session/update", params: { sessionId: "acp-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Thinking..." } } } });
				send({ method: "session/update", params: { sessionId: "acp-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: appendedPrompt + "|" + selectedModel + "|" + selectedThought } } } });
				send({ id: msg.id, result: { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 25, cachedReadTokens: 40, cachedWriteTokens: 0, totalTokens: 165 } } });
			} else if (msg.method === "session/close") {
				process.exit(0);
			}
		});
	`;

	const streamFn = createAntigravityStreamFunction(() => spawnFakeAcp(fakeScript));
	const stream = streamFn(
		TEST_MODEL,
		normalizeContext({ systemPrompt: "TUTOR_PROMPT", tools: [], messages: [{ role: "user", content: "Hello", timestamp: 2 }] }),
		{ reasoning: "medium", sessionId: "chat-1" },
	);
	const result = await stream.result() as AssistantMessage & { cliContextWindow?: number };

	assert.equal(result.stopReason, "stop");
	assert.equal(result.cliContextWindow, 512000);
	assert.equal(result.usage.input, 100);
	assert.equal(result.usage.output, 25);
	assert.equal(result.usage.cacheRead, 40);
	assert.deepEqual(result.content, [
		{ type: "thinking", thinking: "Thinking..." },
		{ type: "text", text: "TUTOR_PROMPT|gemini-3.8-flash|medium" },
	]);
});

test("denies built-in tools, approves and bridges Twig MCP tools, and reuses ACP session across turns", async () => {
	let spawns = 0;
	const fakeScript = `
		const readline = require("readline");
		const send = (obj) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...obj }) + "\\n");
		let mcpServer = null;
		let mcpSessionId = null;
		let promptCount = 0;
		let pendingPromptId = null;

		async function mcpPost(body) {
			const headers = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
			for (const h of mcpServer.headers || []) headers[h.name] = h.value;
			if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;
			const res = await fetch(mcpServer.url, { method: "POST", headers, body: JSON.stringify(body) });
			const sid = res.headers.get("mcp-session-id");
			if (sid) mcpSessionId = sid;
			const text = await res.text();
			const dataLine = text.split("\\n").find((l) => l.startsWith("data: "));
			return JSON.parse(dataLine ? dataLine.slice(6) : text);
		}

		readline.createInterface({ input: process.stdin }).on("line", async (line) => {
			if (!line.trim()) return;
			const msg = JSON.parse(line);
			if (msg.method === "initialize") {
				send({ id: msg.id, result: { protocolVersion: 1 } });
			} else if (msg.method === "session/new") {
				mcpServer = msg.params.mcpServers[0];
				await mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fake", version: "1.0" } } });
				send({ id: msg.id, result: { sessionId: "acp-2" } });
			} else if (msg.method === "session/set_config_option") {
				send({ id: msg.id, result: { configOptions: [] } });
			} else if (msg.method === "session/prompt") {
				promptCount++;
				pendingPromptId = msg.id;
				if (promptCount === 1) {
					// First attempt a built-in tool (must be denied)
					send({
						id: "perm-builtin",
						method: "session/request_permission",
						params: {
							sessionId: "acp-2",
							toolCall: { toolCallId: "call_bad", name: "run_command", rawInput: { cmd: "ls" } },
							options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }]
						}
					});
				} else {
					// Second turn on the SAME warm session!
					const text = msg.params.prompt.map((b) => b.text).join("");
					send({ method: "session/update", params: { sessionId: "acp-2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "TURN2:" + text } } } });
					send({ id: pendingPromptId, result: { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } });
				}
			} else if (msg.id === "perm-builtin") {
				if (msg.result?.outcome?.optionId !== "deny") {
					send({ id: pendingPromptId, error: { code: -1, message: "built-in tool should have been denied" } });
					return;
				}
				// Now request permission for Twig's MCP tool
				send({
					id: "perm-mcp",
					method: "session/request_permission",
					params: {
						sessionId: "acp-2",
						toolCall: { toolCallId: "call_echo_1", name: "mcp_learnharness_twig_echo", rawInput: { msg: "hi", toolSummary: "Echo hi" } },
						options: [{ optionId: "allow", kind: "allow_once" }, { optionId: "deny", kind: "reject_once" }]
					}
				});
			} else if (msg.id === "perm-mcp") {
				if (msg.result?.outcome?.optionId !== "allow") {
					send({ id: pendingPromptId, error: { code: -1, message: "mcp tool should have been allowed" } });
					return;
				}
				const toolRes = await mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "twig_echo", arguments: { msg: "hi" } } });
				const echoed = toolRes.result?.content?.[0]?.text || "";
				send({ method: "session/update", params: { sessionId: "acp-2", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GOT:" + echoed } } } });
				send({ id: pendingPromptId, result: { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } } });
			} else if (msg.method === "session/close") {
				process.exit(0);
			}
		});
	`;

	const streamFn = createAntigravityStreamFunction(() => {
		spawns++;
		return spawnFakeAcp(fakeScript);
	});

	const user1: Message = { role: "user", content: "Run echo", timestamp: 2 };

	// Step 1: Model tries built-in (denied), then calls Twig MCP tool -> stream finishes with toolUse
	const turn1a = await streamFn(
		TEST_MODEL,
		normalizeContext({ systemPrompt: "You are a tutor.", tools: [ECHO_TOOL], messages: [user1] }),
		{ sessionId: "chat-2" },
	).result();
	assert.equal(turn1a.stopReason, "toolUse", turn1a.errorMessage);
	assert.equal(spawns, 1);
	assert.deepEqual(turn1a.content, [{ type: "toolCall", id: "call_echo_1", name: "twig_echo", arguments: { msg: "hi" } }]);

	// Step 2: Twig returns tool result -> continues SAME live process
	const toolResult: Message = {
		role: "toolResult",
		toolCallId: "call_echo_1",
		toolName: "twig_echo",
		content: [{ type: "text", text: "ECHO_OK" }],
		isError: false,
		timestamp: 3,
	};
	const turn1b = await streamFn(
		TEST_MODEL,
		normalizeContext({ systemPrompt: "You are a tutor.", tools: [ECHO_TOOL], messages: [user1, turn1a, toolResult] }),
		{ sessionId: "chat-2" },
	).result();
	assert.equal(turn1b.stopReason, "stop", turn1b.errorMessage);
	assert.equal(spawns, 1);
	assert.deepEqual(turn1b.content, [{ type: "text", text: "GOT:ECHO_OK" }]);

	// Step 3: Next user turn -> reuses SAME warm ACP session (no second spawn!)
	const user2: Message = { role: "user", content: "Follow up", timestamp: 4 };
	const turn2 = await streamFn(
		TEST_MODEL,
		normalizeContext({ systemPrompt: "You are a tutor.", tools: [ECHO_TOOL], messages: [user1, turn1a, toolResult, turn1b, user2] }),
		{ sessionId: "chat-2" },
	).result();
	assert.equal(turn2.stopReason, "stop");
	assert.equal(spawns, 1);
	assert.deepEqual(turn2.content, [{ type: "text", text: "TURN2:Follow up" }]);
});
