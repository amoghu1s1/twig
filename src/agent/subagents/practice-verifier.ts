/**
 * Opt-in pre-pose verifier for Practice v2 (`verifySolutions: true`):
 * solves the posed problem blind (without seeing `modelSolution`) on the
 * configured Cheap model slot (or runs a two-pass consistency check) before
 * the learner sees it. Capped at 1 retry per turn by PracticeGate.
 */

import { Type } from "typebox";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";

export interface PracticeVerificationRequest {
	toolName: string;
	statement: string;
	modelSolution: string;
	options?: Array<{ label: string; value?: string }>;
	correctAnswer?: string | string[];
	categories?: Array<{ id: string; label: string }>;
	items?: Array<{ id: string; prompt: string }>;
	correctMapping?: Record<string, string>;
	language?: string;
	starterCode?: string;
	tests?: string;
}

export type PracticeVerificationResult = { ok: true } | { ok: false; issue: string };

const verificationSchema = Type.Object({
	ok: Type.Boolean({
		description: "true if the problem is clear, self-contained, and the committed solution/answer key agrees with your independent solution; false if there is a contradiction, ambiguity, missing given, or error.",
	}),
	issue: Type.Optional(
		Type.String({
			description: "Required when ok is false: concrete 1-2 sentence explanation of the error, mismatch, or ambiguity.",
		}),
	),
});

const VERIFIER_SYSTEM_PROMPT = `You are a strict, independent verifier for practice problems before a learner sees them.
Your job:
1. Solve the problem independently from the statement (and any options/items/code tests) first.
2. Check whether the statement is unambiguous and self-contained.
3. Compare your independent answer against the committed model solution / answer key.
4. Call submit_verification once with ok: true if everything is sound and consistent, or ok: false with a concise, concrete issue if there is a mathematical/factual error, wrong answer key, missing given, or ambiguity.

Be strict on factual and mathematical accuracy, and tolerant of benign wording differences when the reasoning and final answer agree.`;

function buildPrompt(req: PracticeVerificationRequest): string {
	const lines = [`Format: ${req.toolName}`, "", "Problem statement:", req.statement];
	if (req.options?.length) {
		lines.push("", "Options:", ...req.options.map((o, i) => `${i + 1}. ${o.label}${o.value ? ` (value: ${o.value})` : ""}`));
	}
	if (req.correctAnswer !== undefined) {
		lines.push("", `Committed correctAnswer: ${JSON.stringify(req.correctAnswer)}`);
	}
	if (req.categories?.length && req.items?.length) {
		lines.push(
			"",
			"Categories:",
			...req.categories.map((c) => `- ${c.id}: ${c.label}`),
			"",
			"Items:",
			...req.items.map((it) => `- ${it.id}: ${it.prompt}`),
			"",
			`Committed correctMapping: ${JSON.stringify(req.correctMapping ?? {})}`,
		);
	}
	if (req.language) {
		lines.push("", `Language: ${req.language}`, "Starter code:", req.starterCode ?? "");
		if (req.tests) lines.push("Tests:", req.tests);
	}
	lines.push("", "Committed modelSolution:", req.modelSolution);
	return lines.join("\n");
}

export async function verifyPracticeProblem(
	engine: PiEngine | undefined,
	req: PracticeVerificationRequest,
	signal?: AbortSignal,
): Promise<PracticeVerificationResult> {
	if (!engine) return { ok: true };
	try {
		const res = await runSubmitAgent<{ ok: boolean; issue?: string }>({
			role: "analyst",
			toolName: "submit_verification",
			toolDescription: "Submit the verification verdict for this practice problem.",
			parameters: verificationSchema,
			fill: (raw: { ok?: boolean; issue?: string }) => ({
				ok: raw.ok === true,
				...(typeof raw.issue === "string" && raw.issue.trim() ? { issue: raw.issue.trim() } : {}),
			}),
			validate: (v) => (!v.ok && !v.issue ? "When ok is false, provide a concise issue explaining what failed." : null),
			systemPrompt: VERIFIER_SYSTEM_PROMPT,
			prompt: buildPrompt(req),
			engine,
			signal,
			maxTurns: 2,
			onStep: () => {},
			neverSubmitted: "Verifier did not submit.",
		});
		return res.ok ? { ok: true } : { ok: false, issue: res.issue ?? "Verification flagged an issue." };
	} catch {
		// Verification is best-effort safety: never block a practice session if the cheap model errors.
		return { ok: true };
	}
}
