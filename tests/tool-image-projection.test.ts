import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeImageContent, projectView, type LhMessage } from "../src/core/index.ts";
import { SessionModel } from "../components/session-core.ts";

const image = { type: "image" as const, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", mimeType: "image/png" };
const call = { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "c1", name: "pdf_view", arguments: { path: "notes.pdf", page: 1 } }], api: "openai-responses", provider: "fixture", model: "fixture", timestamp: 1, stopReason: "toolUse", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as LhMessage;
const result = (details: unknown = null) => ({ id: "r1", role: "toolResult", toolCallId: "c1", toolName: "pdf_view", content: [{ type: "text", text: "Page 1 crop" }, image], details, isError: false, timestamp: 2 }) as LhMessage;

test("persisted tool images survive projection and reload with null details", () => {
	const record = JSON.parse(JSON.stringify([call, result()])) as LhMessage[];
	const part = projectView(record)[0]!.parts.find((p) => p.toolCallId === "c1")!;
	assert.equal(part.state, "output-available");
	assert.deepEqual(part.images, [image]);
	assert.deepEqual(part.output, { text: "Page 1 crop" });
	assert.ok(!JSON.stringify(part.output).includes(image.data));
});

test("metadata is kept intact without copying image bytes into details", () => {
	const details = { text: "Rendered", page: 1 };
	const part = projectView([call, result(details)])[0]!.parts.find((p) => p.toolCallId === "c1")!;
	assert.deepEqual(part.output, details);
	assert.deepEqual(part.images, [image]);
});

test("live image results project before turn-end records arrive", () => {
	const view = projectView([call], { inFlight: true, streamingIds: new Set([call.id]), executions: new Map([["c1", { isError: false, output: { text: "Rendered" }, images: [image] }]]) });
	assert.deepEqual(view[0]!.parts.find((p) => p.toolCallId === "c1")!.images, [image]);
});

test("native image extraction ignores unrelated and malformed blocks", () => {
	assert.deepEqual(nativeImageContent(null), []);
	assert.deepEqual(nativeImageContent([{ type: "text", text: "not an image" }, { type: "image", data: 7 }, image]), [image]);
});

test("live tool execution images survive the real session state machine", async () => {
	const event = { type: "tool_execution_end", toolCallId: "c1", toolName: "pdf_view", isError: false, result: { content: [{ type: "text", text: "Rendered live" }, image], details: null } };
	const model = new SessionModel({ chatId: "chat_fixture", initialMessages: [call], fetch: (async (input) => {
		const url = String(input);
		if (url === "/api/chat") return Response.json({ ok: true });
		if (url.endsWith("/stream")) return new Response("data: " + JSON.stringify(event) + "\n\ndata: [DONE]\n\n");
		if (url === "/api/chats/chat_fixture") return Response.json({ messages: [call] });
		throw new Error("Unexpected request " + url);
	}) as typeof fetch });
	let observed: unknown;
	model.onChange = () => {
		const part = model.getState().messages.flatMap((m) => m.parts).find((p) => p.toolCallId === "c1");
		if (part?.images?.length) observed = { images: part.images, output: part.output };
	};
	await model.send({ type: "continue" });
	assert.deepEqual(observed, { images: [image], output: { text: "Rendered live" } });
});
