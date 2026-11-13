/**
 * Session → markdown — the ONE formatting engine (owner ruling 2026-09-27).
 *
 * The extractor's view of a teaching session and the future user-facing
 * session export share this engine: a session is rendered as clean,
 * readable markdown — speaker headers, quiz/check-in blocks, tool notes —
 * with optional message-id anchors. Since the submit-schema slim
 * (2026-09-28) propositions no longer report message ids — the extractor
 * renders anchorless and provenance is chat-level — so the anchors today
 * serve only the future user-facing export; `anchors: false` mints the
 * same document without them.
 *
 * Pure core: native messages in (LhMessage), string out. Content parity
 * with the coverage line builder (core/coverage.ts messageViewLines) is
 * deliberate — every message that produces view lines produces a markdown
 * block, in the same order — but the formats are SEPARATE by design
 * (2026-09-27): coverage fingerprints hash the line format and stay stable
 * (no mass re-extraction when presentation changes); markdown is
 * presentation. A failed tool call renders nothing (retry context, not
 * learning evidence); custom markers are invisible, same as the view.
 */

import { citationsToReadableText } from "./citations.ts";
import { CODE_EXERCISE_TOOL } from "./code-exercise.ts";
import type { LhMessage } from "./native-messages.ts";
import {
	failedOutputCallIds,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	problemInputForConclude,
	SEND_TO_USER_TOOL,
	userFacingTextOf,
	pluginQuestionResultMatches,
} from "./native-messages.ts";
import { readPluginQuestionMessageAnnotation, readPluginQuestionAnswer, readPluginQuestionCancellation } from "./plugin-questions.ts";
import { readPluginProblemSnapshot, readPluginProblemSubmission, pluginProblemById } from "./plugin-problems.ts";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { imageDataUrlMarkdown, imageMarker } from "./images.ts";

/** How images render: "describe" (default) is the base64-free `[Image mime]`
 *  marker, safe for any LLM/background prompt; "embed" inlines the data URL
 *  and is for the explicit user export only. */
export type ImageMode = "describe" | "embed";

function renderImage(c: unknown, n: number, mode: ImageMode): string {
	const block = c as { mimeType?: unknown; data?: unknown };
	return mode === "embed" ? imageDataUrlMarkdown(block, `Image ${n}`) : imageMarker(block);
}

function hasNativeImage(content: unknown): boolean {
	return Array.isArray(content) && content.some((c) => (c as { type?: string } | null)?.type === "image");
}

/** Text and images of one content array in their ORIGINAL block order
 *  (a picture between two paragraphs stays between them). */
function orderedParts(content: unknown, mode: ImageMode): string[] {
	if (typeof content === "string") return content.trim() ? [content.trim()] : [];
	if (!Array.isArray(content)) return [];
	let n = 0;
	const out: string[] = [];
	for (const c of content as Array<{ type?: string; text?: string }>) {
		if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) out.push(citationsToReadableText(c.text.trim()));
		else if (c?.type === "image") out.push(renderImage(c, ++n, mode));
	}
	return out;
}

/** The practice join context (owner-approved, 2026-10-06 export round):
 *  practice tool RESULTS are acks — the statement, outcome, and verdict
 *  all live in the assistant's call arguments, and the model solution
 *  commits at POSE time. The markdown blocks join them the same way the
 *  view seam folds cards (clean-only: a refused pose's result is errored
 *  and renders nothing before this join is ever reached). */
export interface MarkdownContext {
	messages: ReadonlyArray<LhMessage>;
	/** toolCallId → the call part's name + arguments. */
	calls: Map<string, { name: string; args: Record<string, unknown> | undefined }>;
	failedOutputCalls?: ReadonlySet<string>;
}

function markdownContext(messages: ReadonlyArray<LhMessage>): MarkdownContext {
	const calls: MarkdownContext["calls"] = new Map();
	for (const message of messages) {
		if ((message as { role?: string }).role !== "assistant") continue;
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const block = part as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (block.type === "toolCall" && typeof block.id === "string") {
				calls.set(block.id, {
					name: typeof block.name === "string" ? block.name : "",
					args: (block.arguments ?? undefined) as Record<string, unknown> | undefined,
				});
			}
		}
	}
	return { messages, calls, failedOutputCalls: failedOutputCallIds(messages) };
}

/** solvedWithHints → "Solved with hints" — the outcome enum reads as prose. */
function outcomeLabel(outcome: string): string {
	const spaced = outcome.replace(/([a-z])([A-Z])/g, (_, lo: string, hi: string) => `${lo} ${hi.toLowerCase()}`);
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** One tool result's learner-visible outcome, rendered as body lines. */
function toolResultBody(result: ToolResultMessage, ctx?: MarkdownContext): { heading: string; body: string[] } {
	const pluginAnswer = readPluginQuestionAnswer(result.details);
	const cancellation = readPluginQuestionCancellation(result.details);
	if (pluginAnswer || cancellation) {
		const bound = ctx?.messages.some(message => message.role === "assistant" && Array.isArray(message.content) && message.content.some((block, contentIndex) => {
			if (block.type !== "toolCall") return false;
			const annotation = readPluginQuestionMessageAnnotation(message, contentIndex);
			return annotation.status !== "absent" && pluginQuestionResultMatches(result as LhMessage, { messageId: message.id, contentIndex, toolCallId: block.id, toolName: block.name }, annotation);
		}));
		if (!bound) return { heading: "Question", body: ["Question unavailable"] };
		if (cancellation) return { heading: "Question", body: ["The question was cancelled without a learner answer."] };
		const body = [`**Answer:** ${typeof pluginAnswer!.answer === "string" ? pluginAnswer!.answer : JSON.stringify(pluginAnswer!.answer)}`];
		if (pluginAnswer!.thinking !== undefined) body.push(`**Thinking:** ${pluginAnswer!.thinking}`);
		if (pluginAnswer!.readingThinking !== undefined) body.push(`**Reading thinking:** ${pluginAnswer!.readingThinking}`);
		return { heading: "Learner answer", body };
	}
	const out = result.details as
		| Partial<{
				questionText: string;
				correct: boolean;
				dontKnow: boolean;
				note: string;
				text: string;
				answers: string[];
				other: string;
				dismissed: boolean;
		  }>
		| undefined;

	if (
		result.toolName === "quiz" ||
		result.toolName === "probe" ||
		result.toolName === "explain" ||
		result.toolName === "recall"
	) {
		const heading =
			result.toolName === "quiz"
				? "Quiz"
				: result.toolName === "probe"
					? "Probe"
					: result.toolName === "recall"
						? "Recall"
						: "Recall check"; // explain — the teach free-recall name
		const question = typeof out?.questionText === "string" && out.questionText ? out.questionText : "(no question text)";
		const body = [`**Q:** ${question}`];
		// The question's figure, inline (owner, 2026-10-27) — it rides the call, not the answer.
		const figure = ctx?.calls.get(result.toolCallId)?.args?.figure;
		if (typeof figure === "string" && figure.trim()) body.push(figure.trim());
		if (out?.dismissed === true) body.push("The learner skipped this check.");
		else if (out?.dontKnow === true) body.push("The learner did not know.");
		else if (out?.correct === true) body.push("The learner answered correctly.");
		else if (out?.correct === false) body.push("The learner answered incorrectly.");
		else if (typeof out?.text === "string" && out.text.trim()) body.push(`The learner answered in his own words: ${out.text.trim()}`);
		if (typeof out?.note === "string" && out.note) body.push(`*(his thinking: ${out.note})*`);
		return { heading, body };
	}

	const pluginProblem = readPluginProblemSnapshot((result.details as { pluginProblem?: unknown } | undefined)?.pluginProblem);
	if (pluginProblem && ctx && pluginProblemById(ctx.messages, pluginProblem.problemId)) {
		return { heading: "Problem", body: [pluginProblem.input.statement] };
	}

	if (result.toolName === CODE_EXERCISE_TOOL) {
		const code = result.details as
			| Partial<{ questionText: string; thinking: string; graded: boolean; runs: number; dismissed: boolean; lastRun: { passed?: boolean; error?: string; timedOut?: boolean } }>
			| undefined;
		const question = typeof code?.questionText === "string" && code.questionText ? code.questionText : "(no question text)";
		const body = [`**Q:** ${question}`];
		if (code?.dismissed === true) body.push("The learner skipped this exercise.");
		else if (code?.graded === true && code.lastRun?.passed === true) body.push("The learner's code passed the checks.");
		else if (code?.graded === true) body.push("The learner's code did not pass the checks.");
		else if (code?.lastRun?.timedOut === true) body.push("The learner's code timed out.");
		else if (typeof code?.lastRun?.error === "string") body.push("The learner's code raised an error.");
		else body.push("The learner ran their code.");
		if (typeof code?.thinking === "string" && code.thinking) body.push(`*(his thinking: ${code.thinking})*`);
		return { heading: "Code exercise", body };
	}

	if (ctx !== undefined && result.toolName === PRACTICE_PROBLEM_TOOL) {
		const statement = ctx.calls.get(result.toolCallId)?.args?.statement;
		return {
			heading: "Problem",
			body: [typeof statement === "string" && statement.trim() ? statement.trim() : "(no statement)"],
		};
	}

	if (ctx !== undefined && result.toolName === PRACTICE_CONCLUDE_TOOL) {
		const args = ctx.calls.get(result.toolCallId)?.args;
		const outcome = typeof args?.outcome === "string" && args.outcome.trim() ? args.outcome.trim() : "";
		const verdict = typeof args?.verdict === "string" && args.verdict.trim() ? args.verdict.trim() : undefined;
		if (outcome === "dismissed") return { heading: "Concluded", body: ["The learner skipped this problem."] };
		const label = outcome !== "" ? `**${outcomeLabel(outcome)}.**` : "**Concluded.**";
		const body = [verdict !== undefined ? `${label} ${verdict}` : label];
		// The reveal (owner round, 2026-10-05): the solution committed at
		// pose time — the newest cleanly-posed problem before this conclude.
		const input = problemInputForConclude(ctx.messages, result.toolCallId);
		const solution = typeof input?.modelSolution === "string" && input.modelSolution.trim() ? input.modelSolution.trim() : undefined;
		if (solution !== undefined) body.push(`> **Model solution**\n>\n> ${solution.replace(/\n/g, "\n> ")}`);
		return { heading: "Concluded", body };
	}

	if (result.toolName === "ask_user_question") {
		const question = typeof out?.questionText === "string" && out.questionText ? out.questionText : "(no question text)";
		const body = [`**Q:** ${question}`];
		const chosen = [
			...(Array.isArray(out?.answers) ? out!.answers! : []),
			...(typeof out?.other === "string" && out.other.trim() ? [out.other.trim()] : []),
		];
		if (typeof out?.text === "string" && out.text.trim()) body.push(`The learner answered: ${out.text.trim()}`);
		else if (chosen.length > 0) body.push(`The learner chose: ${chosen.join(", ")}`);
		else if (out?.dismissed === true) body.push("The learner skipped this question.");
		if (typeof out?.note === "string" && out.note) body.push(`*(his thinking: ${out.note})*`);
		return { heading: "Question", body };
	}

	// Parity with the line builder: other clean tool results are one line.
	return { heading: "Tool", body: [`*${result.toolName} result delivered*`] };
}

/**
 * ONE message as a markdown block — `null` when the message renders
 * nothing (a failed tool call, a bare marker, an empty text part set).
 * `mid` is the provenance anchor shown when `anchors` is on.
 */
export function messageMarkdown(
	message: LhMessage,
	mid: string,
	anchors = true,
	ctx?: MarkdownContext,
	imageMode: ImageMode = "describe",
): string | null {
	const role = (message as { role?: string }).role;
	const anchor = anchors ? ` · ${mid}` : "";
	const parts: string[] = [];

	if (message.role === "custom" && message.customType === "plugin-problem-submission") {
		const submitted = readPluginProblemSubmission(message.details);
		if (submitted) parts.push(`### Learner${anchor}\n\n\`\`\`json\n${JSON.stringify({ submission: submitted.submission, thinking: submitted.thinking, ...(submitted.processing ? { processing: submitted.processing } : {}) }, null, 2)}\n\`\`\``);
	} else if (role === "user") {
		const content = (message as { content: unknown }).content;
		const blocks = hasNativeImage(content)
			? orderedParts(content, imageMode)
			: userFacingTextOf(content).map((text) => citationsToReadableText(text).trim()).filter(Boolean);
		if (blocks.length > 0) parts.push(`### Learner${anchor}\n\n${blocks.join("\n\n")}`);
	} else if (role === "assistant") {
		for (const text of userFacingTextOf((message as { content: unknown }).content, ctx?.failedOutputCalls ?? failedOutputCallIds([message]))) {
			parts.push(`### Teacher${anchor}\n\n${text.trim()}`);
		}
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const [contentIndex, block] of message.content.entries()) {
				if (block.type !== "toolCall") continue;
				const annotation = readPluginQuestionMessageAnnotation(message, contentIndex);
				if (annotation.status === "posed") parts.push(`### Question${anchor}\n\n${annotation.snapshot.input.question}`);
			}
		}
	} else if (role === "toolResult") {
		const result = message as ToolResultMessage;
		if (result.isError || result.toolName === SEND_TO_USER_TOOL) return null; // retry context or output ack, not learning evidence
		const { heading, body } = toolResultBody(result, ctx);
		const images = Array.isArray(result.content)
			? result.content.filter((c) => (c as { type?: string } | null)?.type === "image").map((c, i) => renderImage(c, i + 1, imageMode))
			: [];
		parts.push(`### ${heading}${anchor}\n\n${[...body.map((line) => citationsToReadableText(line)), ...images].join("\n\n")}`);
	}

	// custom markers are invisible, same as the extraction view.
	return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * A whole session (or one extraction BATCH — same engine, subset of
 * messages) as one markdown document. Blocks render in message order;
 * messages that render nothing are skipped silently. The optional title
 * mints the document header (`# <title>`).
 */
export function sessionMarkdown(
	messages: ReadonlyArray<LhMessage>,
	opts: { title?: string; anchors?: boolean; imageMode?: ImageMode } = {},
): string {
	const blocks: string[] = [];
	if (opts.title !== undefined && opts.title.length > 0) blocks.push(`# ${opts.title}`);
	const ctx = markdownContext(messages);
	for (const message of messages) {
		const block = messageMarkdown(message, (message as { id?: string }).id ?? "", opts.anchors ?? true, ctx, opts.imageMode ?? "describe");
		if (block !== null) blocks.push(block);
	}
	return blocks.join("\n\n");
}
