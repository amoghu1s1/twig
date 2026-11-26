import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type AssistantMessage,
	type FauxResponseFactory,
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { PATHS } from "../config.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { createPracticeGate, problemTool, concludeTool } from "../src/agent/tools/practice.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import {
	buildPracticeSeededRequest,
	parsePracticeSummaryInput,
	type LhMessage,
} from "../src/core/index.ts";
import { findMistakes } from "../src/core/mistakes.ts";
import { reviewEventsFromMessages } from "../src/core/review-events.ts";
import { POST as createChatPost } from "../app/api/chats/route.ts";
import { PATCH as patchPracticeRoute } from "../app/api/chats/[id]/practice/route.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* ignore */
		}
	}
});

function createPracticeChat(title: string) {
	const chat = chatStore.createChat(title, "practice");
	chatStore.saveSettings(chat.id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	createdChats.push(chat.id);
	return chat;
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	assert.equal(ack.status, 200);
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return "";
	return new Response(handle.subscribe()).text();
}

function scripted(steps: FauxResponseStep[]): { engine: PiEngine; calls: string[] } {
	const calls: string[] = [];
	const faux = createFauxCore({});
	const wrap = (step: FauxResponseStep) => async (context: TranscriptContext): Promise<AssistantMessage> => {
		calls.push(context.messages.map((m) => JSON.stringify((m as { content?: unknown }).content)).join("\n"));
		return typeof step === "function"
			? await (step as FauxResponseFactory)(context, undefined, undefined as never, undefined as never)
			: step;
	};
	faux.setResponses(steps.map(wrap));
	return { engine: { model: faux.getModel(), streamFn: faux.streamSimple }, calls };
}

describe("Practice v2 flow & routes", () => {
	it("supports dock actions (hint with empty text, show-solution, step-down, flag-bad)", async () => {
		const chat = createPracticeChat("Test: dock actions");
		const POSE = { statement: "Solve x+2=5", mode: "recall", modelSolution: "x=3" };
		const { engine, calls } = scripted([
			() => fauxAssistantMessage([fauxToolCall("problem", POSE, { id: "call-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxText("Hint R1: isolate x.")]),
			() => fauxAssistantMessage([fauxToolCall("conclude", { outcome: "voided", verdict: "Replacing.", rung: null, missClass: null, retest: false }, { id: "call-v1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage([fauxToolCall("problem", { ...POSE, statement: "Solve 2x=6" }, { id: "call-2" })], { stopReason: "toolUse" }),
		]);
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) =>
			createPracticeAgent({ chatId: chat.id, chatStore }, { engine, messages: opts.messages });

		await drainTurn(post(chat.id, { type: "text", text: "go" }), factory);
		// Hint with empty text MUST be accepted
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-1", text: "", action: "hint" }), factory);
		assert.ok(calls[calls.length - 1]!.includes("[HINT REQUEST]"));

		// Flag bad lets voided conclude → replacement problem in the same turn
		await drainTurn(post(chat.id, { type: "thinking", problemCallId: "call-1", text: "", action: "flag-bad" }), factory);
		assert.ok(calls[calls.length - 2]!.includes("[FLAG BAD QUESTION]"));

		const record = chatStore.getChat(chat.id)!;
		assert.equal(findMistakes(chat.id, record.messages).length, 0, "voided problems do not enter Mistakes");
		assert.equal(reviewEventsFromMessages(record.messages, chat.id).length, 0, "voided problems emit no Review evidence");
	});

	it("PATCH /api/chats/[id]/practice persists dial updates and validates inputs", async () => {
		const chat = createPracticeChat("Test: dial patch");
		const res = await patchPracticeRoute(
			new Request(`http://test/api/chats/${chat.id}/practice`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ coaching: "direct", depth: "deep", presentation: "applied", verifySolutions: true }),
			}),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { practice: Record<string, unknown> };
		assert.deepEqual(body.practice, {
			coaching: "direct",
			depth: "deep",
			presentation: "applied",
			verifySolutions: true,
		});
		assert.deepEqual(chatStore.getChat(chat.id)!.practice, body.practice);

		const bad = await patchPracticeRoute(
			new Request(`http://test/api/chats/${chat.id}/practice`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ coaching: "bogus" }),
			}),
			{ params: Promise.resolve({ id: chat.id }) },
		);
		assert.equal(bad.status, 400);
	});

	it("POST /api/chats persists mistakesContext and practice dials cleanly", async () => {
		const res = await createChatPost(
			new Request("http://test/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: "Practice filtered mistakes",
					kind: "practice",
					practice: { coaching: "socratic", depth: "recall" },
					mistakesContext: [
						{ id: "m1", question: "Show that every subgroup of index 2 is normal.", topic: "Cosets", errorType: "wrongMethod", whatYouDid: "Used abelian swap", rule: "Check commutativity" },
					],
				}),
			}),
		);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { id: string; practice?: Record<string, unknown> };
		createdChats.push(body.id);
		assert.equal(body.practice?.coaching, "socratic");
		assert.equal(body.practice?.depth, "recall");
		const stored = chatStore.getChat(body.id)!;
		assert.ok(stored.messages.some((m) => m.role === "custom" && m.customType === "mistakes-context"));
	});

	it("practice_summary validates targets and builds Teach/Practice follow-up seeds", async () => {
		const parsed = parsePracticeSummaryInput({
			summary: "Strong recall overall; one blind spot on normal subgroups.",
			solid: [{ area: "Lagrange", note: "Cleanly stated", targets: ["n_lagrange"] }],
			needsPractice: [{ area: "Cosets", note: "Needs speed", targets: ["n_coset"] }],
			remedialTeach: [{ area: "Normality", note: "Conjugation check broke", targets: ["n_normal"] }],
		});
		assert.ok(parsed);
		const seededTeach = buildPracticeSeededRequest(parsed.remedialTeach, "teach", [
			{ id: "n_normal", name: "Normal subgroup", statement: "gHg^{-1} = H" },
		]);
		assert.equal(seededTeach.kind, undefined);
		assert.equal(seededTeach.graphContext?.propositions.length, 1);
		assert.match(seededTeach.openingPrompt, /remedial teaching session/i);

		const seededPractice = buildPracticeSeededRequest(parsed.needsPractice, "practice", [
			{ id: "n_coset", name: "Cosets", statement: "Left cosets partition G" },
		]);
		assert.equal(seededPractice.kind, "practice");
		assert.match(seededPractice.openingPrompt, /follow-up practice session/i);
	});

	it("PracticeGate blocks non-voided same-turn conclude -> pose cleanly", async () => {
		const gate = createPracticeGate({ chatId: "x", chatStore });
		// Seed gate active
		const p1 = await problemTool(gate).execute("c1", { statement: "Q1", mode: "recall", modelSolution: "S1" } as never);
		assert.equal(p1.isError, undefined);
		const c1 = await concludeTool(gate).execute("c2", { outcome: "solved", verdict: "Done", rung: null, missClass: null, retest: false } as never);
		assert.equal(c1.isError, undefined);
		const blocked = await problemTool(gate).execute("c3", { statement: "Q2", mode: "recall", modelSolution: "S2" } as never);
		assert.equal(blocked.isError, true);
	});
});
