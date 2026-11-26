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
	type FauxResponseStep,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { PATHS } from "../config.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { createPracticeAgent } from "../src/agent/teacher-agent.ts";
import { createPracticeGate, problemTool } from "../src/agent/tools/practice.ts";
import { verifyPracticeProblem } from "../src/agent/subagents/practice-verifier.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";
import {
	activeProblemOf,
	gradePracticeCheck,
	gradePracticeMatch,
	practiceCheckInputProblems,
	practiceCodeInputProblems,
	practiceMatchInputProblems,
} from "../src/core/index.ts";

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

function scripted(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({});
	faux.setResponses(
		steps.map((step) => async (ctx: TranscriptContext): Promise<AssistantMessage> =>
			typeof step === "function" ? await step(ctx, undefined, undefined as never, undefined as never) : step,
		),
	);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

describe("Practice v2 multi-format grading, validation, auto-conclude, and verifier", () => {
	it("grades practice_check single & multi-select accurately", () => {
		const input = {
			options: [{ label: "Prime" }, { label: "Even", value: "even" }, { label: "Odd" }],
			correctAnswer: ["Prime", "even"],
		};
		assert.equal(gradePracticeCheck(input, ["Prime", "even"]).correct, true);
		const partial = gradePracticeCheck(input, ["Prime"]);
		assert.equal(partial.correct, false);
		assert.deepEqual(partial.missedValues, ["even"]);

		const extra = gradePracticeCheck(input, ["Prime", "even", "Odd"]);
		assert.equal(extra.correct, false);
		assert.deepEqual(extra.extraValues, ["Odd"]);
	});

	it("grades practice_match and validates mapping integrity", () => {
		const matchInput = {
			statement: "Classify each property.",
			mode: "discrimination" as const,
			categories: [
				{ id: "c1", label: "Group axiom" },
				{ id: "c2", label: "Ring axiom" },
			],
			items: [
				{ id: "i1", prompt: "Identity exists" },
				{ id: "i2", prompt: "Distributivity" },
			],
			modelSolution: "Identity is group; distributivity links both operations.",
			correctMapping: { i1: "c1", i2: "c2" },
		};
		assert.deepEqual(practiceMatchInputProblems(matchInput), []);
		assert.equal(gradePracticeMatch(matchInput, { i1: "c1", i2: "c2" }).correct, true);
		const partial = gradePracticeMatch(matchInput, { i1: "c1", i2: "c1" });
		assert.equal(partial.correct, false);
		assert.deepEqual(partial.perItem, { i1: true, i2: false });
		assert.deepEqual(partial.score, { right: 1, total: 2 });

		assert.ok(practiceCheckInputProblems({ statement: "", modelSolution: "S", options: [], correctAnswer: "x" }).length > 0);
		assert.ok(practiceCodeInputProblems({ statement: "Write f", modelSolution: "def f(): pass", tests: "  " }).length > 0);
	});

	it("clean first-try structured submit auto-concludes immediately with zero extra LLM turn; miss triggers coaching", async () => {
		const chat = createPracticeChat("Test: structured auto-conclude");
		let engineCalls = 0;
		const baseEngine = scripted([
			() => {
				engineCalls++;
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"practice_check",
							{
								statement: "Which is prime?",
								mode: "recall",
								options: [{ label: "2" }, { label: "4" }],
								correctAnswer: "2",
								modelSolution: "2 has only 1 and 2 as divisors.",
							},
							{ id: "call-chk-1" },
						),
					],
					{ stopReason: "toolUse" },
				);
			},
			() => {
				engineCalls++;
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"practice_check",
							{
								statement: "Which is even?",
								mode: "recall",
								options: [{ label: "3" }, { label: "6" }],
								correctAnswer: "6",
								modelSolution: "6 is divisible by 2.",
							},
							{ id: "call-chk-2" },
						),
					],
					{ stopReason: "toolUse" },
				);
			},
			() => {
				engineCalls++;
				return fauxAssistantMessage([fauxText("Notice 3 leaves remainder 1 mod 2.")]);
			},
		]);
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) =>
			createPracticeAgent({ chatId: chat.id, chatStore }, { engine: baseEngine, messages: opts.messages });

		const sendAndDrain = async (input: unknown) => {
			const res = await handleChatRequest(
				new Request("http://test/api/chat", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ chatId: chat.id, input }),
				}),
				factory,
			);
			assert.equal(res.status, 200);
			const h = runningTurn(chat.id);
			if (h) await new Response(h.subscribe()).text();
		};

		await sendAndDrain({ type: "text", text: "go" });
		assert.equal(engineCalls, 1);

		// Clean first-try pass must auto-conclude and NEVER invoke engineCalls again!
		await sendAndDrain({
			type: "practice-structured-submit",
			problemCallId: "call-chk-1",
			format: "check",
			payload: { selected: ["2"] },
			passed: true,
			summaryText: "2",
		});
		assert.equal(engineCalls, 1, "clean first pass skips extra LLM turn");
		assert.equal(activeProblemOf(chatStore.getChat(chat.id)!.messages), null);

		// Move on to second problem, miss it — coaching turn MUST fire
		await sendAndDrain({ type: "next" });
		assert.equal(engineCalls, 2);
		await sendAndDrain({
			type: "practice-structured-submit",
			problemCallId: "call-chk-2",
			format: "check",
			payload: { selected: ["3"] },
			passed: false,
			summaryText: "3",
		});
		assert.equal(engineCalls, 3, "miss opens coaching turn");
		assert.equal(activeProblemOf(chatStore.getChat(chat.id)!.messages)?.toolCallId, "call-chk-2");
	});

	it("verifyPracticeProblem flags mismatch and PracticeGate caps retries at 1 per turn", async () => {
		let verifyCount = 0;
		const gate = createPracticeGate({
			chatId: "x",
			chatStore,
			verifyProblem: async () => {
				verifyCount++;
				return { ok: false, issue: "Committed answer contradicts statement." };
			},
		});
		const tool = problemTool(gate);
		const first = await tool.execute("c1", { statement: "2+2=?", mode: "recall", modelSolution: "5" } as never);
		assert.equal(first.isError, true);
		assert.match((first.content[0] as { text: string }).text, /verification flagged an issue/i);

		// Second pose in the same turn bypasses verification due to 1-retry cap
		const second = await tool.execute("c2", { statement: "2+2=?", mode: "recall", modelSolution: "4" } as never);
		assert.equal(second.isError, undefined);
		assert.equal(verifyCount, 1);

		// Direct unit test of verifyPracticeProblem with faux engine
		const fauxVerifier = scripted([
			() => fauxAssistantMessage([fauxToolCall("submit_verification", { ok: false, issue: "Sign error" }, { id: "v1" })], { stopReason: "toolUse" }),
		]);
		const res = await verifyPracticeProblem(fauxVerifier, {
			toolName: "problem",
			statement: "Solve x+1=0",
			modelSolution: "x=1",
		});
		assert.deepEqual(res, { ok: false, issue: "Sign error" });
	});
});
