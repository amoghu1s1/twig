import assert from "node:assert/strict";
import { test } from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { isAcpAuthError, parseAcpCatalog } from "../src/agent/antigravity/catalog.ts";
import { AcpRpcError } from "../src/agent/antigravity/acp-client.ts";

test("parseAcpCatalog combines configOptions base models with availableModels thinking levels", () => {
	const models = parseAcpCatalog({
		sessionId: "s-1",
		configOptions: [
			{
				id: "model",
				options: [
					{ value: "gemini-4-neon", name: "Gemini 4 Neon" },
					{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
					{ value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
				],
			},
		],
		models: {
			availableModels: [
				{ modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
				{ modelId: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
				{ modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
				{ modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (XHigh)" },
				{ modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
				{ modelId: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
				{ modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
				{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
			],
		},
	}, 1_048_576);

	assert.equal(models.length, 3);
	const neon = models.find((m) => m.id === "gemini-4-neon")!;
	assert.equal(neon.provider, "antigravity");
	assert.equal(neon.api, "antigravity-acp");
	assert.equal(neon.contextWindow, 1_048_576);
	assert.deepEqual(getSupportedThinkingLevels(neon), ["low", "medium", "high", "xhigh"]);

	const flash = models.find((m) => m.id === "gemini-3.8-flash")!;
	assert.deepEqual(getSupportedThinkingLevels(flash), ["low", "medium", "high"]);

	const oss = models.find((m) => m.id === "gpt-oss-120b-medium")!;
	assert.equal(oss.reasoning, false);
	assert.deepEqual(getSupportedThinkingLevels(oss), ["off"]);
});

test("isAcpAuthError identifies ACP auth errors without false positives", () => {
	assert.equal(isAcpAuthError(new AcpRpcError("Authentication required", -32000)), true);
	assert.equal(isAcpAuthError(new Error("User is not signed in")), true);
	assert.equal(isAcpAuthError(new Error("Network timeout")), false);
});
