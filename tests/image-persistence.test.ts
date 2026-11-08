/**
 * Native image compatibility at the core seams: the composer now uploads
 * blob-backed attachments, but the record/projection primitives still
 * understand the native image block shape (legacy callers, agent tool
 * results, and the #66 projection contract).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { imageBlock } from "../src/core/images.ts";
import { estimateMessageTokens, serializeForSummary } from "../src/core/compaction.ts";
import { inputAppends, parseChatInput } from "../src/core/input-events.ts";
import { newUserMessage, toLlmMessages, asAgentMessages, type LhMessage } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";
import { sessionMarkdown } from "../src/core/session-markdown.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const toolResult = (content: unknown, details?: unknown): LhMessage =>
	({ id: "r1", role: "toolResult", toolCallId: "c1", toolName: "read", content, details, isError: false, timestamp: 3 }) as LhMessage;

describe("native image persistence and model context", () => {
	it("text-only records stay plain strings; images keep text-first, input order", () => {
		assert.equal(newUserMessage("hello").content, "hello");
		const a = imageBlock("image/png", PNG);
		const b = imageBlock("image/png", PNG);
		const m = newUserMessage("look", [a, b]);
		assert.deepEqual(m.content, [{ type: "text", text: "look" }, a, b]);
		const only = newUserMessage("", [a]);
		assert.deepEqual(only.content, [a]);
		const input = parseChatInput({ type: "text", text: "look", images: [a, b] });
		const [appended] = inputAppends({ messages: [] }, input);
		assert.deepEqual((appended as { content: unknown }).content, [{ type: "text", text: "look" }, a, b]);
	});

	it("toLlmMessages passes image blocks through verbatim, minus the record id", () => {
		const a = imageBlock("image/png", PNG);
		const user = newUserMessage("see", [a]);
		const result = toolResult([{ type: "text", text: "shot" }, a]);
		const wire = toLlmMessages(asAgentMessages([user, result])) as unknown as Array<{ content: any[]; id?: string }>;
		assert.deepEqual(wire[0]!.content, [{ type: "text", text: "see" }, a]);
		assert.deepEqual(wire[1]!.content, [{ type: "text", text: "shot" }, a]);
		assert.equal(wire[0]!.id, undefined);
		const reloaded = JSON.parse(JSON.stringify([user, result])) as LhMessage[];
		assert.equal(JSON.stringify(toLlmMessages(asAgentMessages(reloaded))), JSON.stringify(wire));
	});

	it("the compaction image allowance is still 4800 chars for an image block", () => {
		const m = newUserMessage("", [imageBlock("image/png", PNG)]);
		assert.equal(estimateMessageTokens(m), 1200);
	});

	it("summaries carry a marker, never base64, in order", () => {
		const a = imageBlock("image/png", PNG);
		const text = serializeForSummary([
			newUserMessage("before", [a, imageBlock("image/jpeg", PNG)]),
			toolResult([{ type: "text", text: "shot" }, a]),
		]);
		assert.ok(!text.includes(PNG.slice(0, 20)), "no base64 in the summary");
		assert.match(text, /\[LEARNER\] before\n\[Image image\/png\]\n\[Image image\/jpeg\]/);
		assert.match(text, /\[RESULT for read\] shot\n\[Image image\/png\]/);
		assert.ok(!text.includes("[object Object]"));
	});

	it("the view projection renders legacy image user messages in order", () => {
		const m = newUserMessage("see", [imageBlock("image/png", PNG)]);
		const view = projectView([m]);
		assert.equal(view.length, 1);
		assert.deepEqual(view[0]!.parts.map((p) => p.type), ["text", "image"]);
		assert.match(String(view[0]!.parts[1]!.url), /^data:image\/png;base64,/);
	});

	it("markdown: describe is the base64-free default; embed (the user export) keeps the images in order", () => {
		const a = imageBlock("image/png", PNG);
		const messages = [newUserMessage("before", [a]), newUserMessage("", [a]), toolResult([{ type: "text", text: "shot" }, a], null)];
		const plain = sessionMarkdown(messages, { anchors: false });
		assert.ok(!plain.includes(PNG.slice(0, 20)), "no base64 by default");
		assert.ok(plain.includes("### Learner\n\nbefore\n\n[Image image/png]"), plain);
		assert.ok(plain.includes("### Learner\n\n[Image image/png]"), "image-only message is not dropped");
		assert.ok(plain.includes("### Tool\n\n*read result delivered*\n\n[Image image/png]"), plain);
		const md = sessionMarkdown(messages, { anchors: false, imageMode: "embed" });
		const url = `![Image 1](data:image/png;base64,${PNG})`;
		assert.ok(md.includes(`### Learner\n\nbefore\n\n${url}`), md);
		assert.ok(md.includes(`### Learner\n\n${url}`), md);
		assert.ok(md.includes(`### Tool\n\n*read result delivered*\n\n${url}`), md);
	});
});
