import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type JsonObject,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type StreamFunction,
	type ThinkingLevel,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

import { externalCliEnv } from "../../core/auth-env.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { AcpClient, type AcpJsonRpcId } from "./acp-client.ts";
import { isAcpAuthError, type AcpSessionNewResult } from "./catalog.ts";
import { AntigravityError } from "./constants.ts";
import { ANTIGRAVITY_ACP_ARGS, AntigravityLaunchError, createAntigravityLauncher, type RunAntigravity } from "./launch.ts";
import {
	addLiveProcess,
	getLiveProcessForSession,
	getLiveProcessForTools,
	removeLiveProcess,
	type LiveAntigravityProcess,
	type LiveProcessMode,
} from "./live-processes.ts";
import { configurationForReuse, conversationForReuse } from "./reuse-context.ts";
import {
	createAntigravityToolBridge,
	isBridgeToolName,
	toolNameFromAcpMcp,
	type AntigravityToolBridge,
	type PendingToolCall,
} from "./tool-bridge.ts";
import { toAntigravityInput, toUnlabelledBlocks, type AcpContentBlock } from "./transcript.ts";

const ABORT_MESSAGE = "Request was aborted";
const START_FAILED_MESSAGE = "agy CLI failed to start";
const HANDSHAKE_TIMEOUT_MS = 20_000;

type AcpThoughtLevel = "low" | "medium" | "high" | "xhigh";

const THOUGHT_LEVEL_MAP: Record<ThinkingLevel, AcpThoughtLevel> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "xhigh",
};

const STOP_REASONS: Record<string, StopReason> = {
	end_turn: "stop",
	stop_sequence: "stop",
	max_tokens: "length",
	max_turn_requests: "length",
	refusal: "error",
	cancelled: "aborted",
};

export function toThoughtLevel(model: Model<Api>, level: ThinkingLevel | undefined): AcpThoughtLevel | undefined {
	if (!model.reasoning || !level) return undefined;
	return THOUGHT_LEVEL_MAP[level];
}

function createOutput(model: Model<Api>): AssistantMessage & Pick<LhMessage, "cliContextWindow"> {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: Date.now(),
	};
}

type AcpPromptUsage = {
	inputTokens?: number;
	outputTokens?: number;
	cachedReadTokens?: number;
	cachedWriteTokens?: number;
	thoughtTokens?: number;
	totalTokens?: number;
};

type AcpPromptResult = {
	stopReason?: string;
	usage?: AcpPromptUsage;
};

class AntigravityTurn {
	private readonly output: AssistantMessage & Pick<LhMessage, "cliContextWindow">;
	private started = false;
	finished = false;
	private activeBlock: { type: "text" | "thinking"; contentIndex: number } | null = null;

	constructor(
		private readonly stream: AssistantMessageEventStream,
		model: Model<Api>,
	) {
		this.output = createOutput(model);
	}

	getMessage(): AssistantMessage {
		return this.output;
	}

	setContextWindow(tokens: number | undefined): void {
		if (!this.finished && tokens !== undefined && tokens > 0) {
			this.output.cliContextWindow = tokens;
		}
	}

	appendThinking(text: string): void {
		if (this.finished || !text) return;
		this.start();
		if (this.activeBlock?.type !== "thinking") {
			this.closeActiveBlock();
			const contentIndex = this.output.content.length;
			this.output.content.push({ type: "thinking", thinking: "" });
			this.activeBlock = { type: "thinking", contentIndex };
			this.stream.push({ type: "thinking_start", contentIndex, partial: this.output });
		}
		const block = this.output.content[this.activeBlock.contentIndex];
		if (block?.type === "thinking") {
			block.thinking += text;
			this.stream.push({ type: "thinking_delta", contentIndex: this.activeBlock.contentIndex, delta: text, partial: this.output });
		}
	}

	appendText(text: string): void {
		if (this.finished || !text) return;
		this.start();
		if (this.activeBlock?.type !== "text") {
			this.closeActiveBlock();
			const contentIndex = this.output.content.length;
			this.output.content.push({ type: "text", text: "" });
			this.activeBlock = { type: "text", contentIndex };
			this.stream.push({ type: "text_start", contentIndex, partial: this.output });
		}
		const block = this.output.content[this.activeBlock.contentIndex];
		if (block?.type === "text") {
			block.text += text;
			this.stream.push({ type: "text_delta", contentIndex: this.activeBlock.contentIndex, delta: text, partial: this.output });
		}
	}

	admit(calls: ToolCall[]): void {
		if (this.finished) return;
		this.start();
		this.closeActiveBlock();
		for (const call of calls) {
			const contentIndex = this.output.content.length;
			this.output.content.push(call);
			this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
			this.stream.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: this.output });
		}
		this.output.stopReason = "toolUse";
		this.finished = true;
		this.stream.push({ type: "done", reason: "toolUse", message: this.output });
		this.stream.end();
	}

	complete(result: AcpPromptResult): void {
		if (this.finished) return;
		this.start();
		this.closeActiveBlock();
		if (result.usage) this.applyUsage(result.usage);
		const mapped = STOP_REASONS[result.stopReason ?? "end_turn"];
		if (!mapped) {
			this.fail(`Unhandled agy ACP stop reason: ${result.stopReason}`, "error");
			return;
		}
		if (mapped === "aborted") {
			this.fail(ABORT_MESSAGE, "aborted");
			return;
		}
		if (mapped === "error" || mapped === "pending") {
			this.fail("The model refused to complete the request", "error");
			return;
		}
		this.output.stopReason = mapped;
		this.finished = true;
		this.stream.push({ type: "done", reason: mapped, message: this.output });
		this.stream.end();
	}

	fail(message: string, reason: "aborted" | "error"): void {
		if (this.finished) return;
		this.closeActiveBlock();
		this.finished = true;
		this.output.stopReason = reason;
		this.output.errorMessage = message;
		this.stream.push({ type: "error", reason, error: this.output });
		this.stream.end();
	}

	private start(): void {
		if (this.started) return;
		this.started = true;
		this.stream.push({ type: "start", partial: this.output });
	}

	private closeActiveBlock(): void {
		if (!this.activeBlock) return;
		const { type, contentIndex } = this.activeBlock;
		const block = this.output.content[contentIndex];
		this.activeBlock = null;
		if (type === "text" && block?.type === "text") {
			this.stream.push({ type: "text_end", contentIndex, content: block.text, partial: this.output });
		} else if (type === "thinking" && block?.type === "thinking") {
			this.stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: this.output });
		}
	}

	private applyUsage(usage: AcpPromptUsage): void {
		const input = typeof usage.inputTokens === "number" ? usage.inputTokens : 0;
		const output = typeof usage.outputTokens === "number" ? usage.outputTokens : 0;
		const cacheRead = typeof usage.cachedReadTokens === "number" ? usage.cachedReadTokens : 0;
		const cacheWrite = typeof usage.cachedWriteTokens === "number" ? usage.cachedWriteTokens : 0;
		const totalTokens = typeof usage.totalTokens === "number"
			? usage.totalTokens
			: input + output + cacheRead + cacheWrite;
		this.output.usage = {
			input,
			output,
			cacheRead,
			cacheWrite,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}
}

function asObject(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

class AntigravityProcess implements LiveAntigravityProcess {
	toolCallIds: string[] = [];
	mode: LiveProcessMode = "idle";
	private acpSessionId: string | undefined;
	private closed = false;
	private stopping = false;
	private signal: AbortSignal | undefined;
	private admitted: PendingToolCall[] = [];
	private contextWindow: number | undefined;
	private pendingError: string | undefined;
	private readonly client: AcpClient;

	constructor(
		child: NonNullable<Awaited<ReturnType<RunAntigravity>>>,
		private readonly bridge: AntigravityToolBridge,
		private readonly cwd: string,
		private turn: AntigravityTurn,
		readonly owner: symbol,
		readonly sessionId: string | undefined,
		private readonly configuration: unknown,
		private conversation: unknown[],
		private readonly declaredToolNames: ReadonlySet<string>,
	) {
		this.client = new AcpClient(child, {
			onNotification: (method, params) => this.handleNotification(method, params),
			onRequest: (id, method, params) => this.handleRequest(id, method, params),
			onError: (error) => this.fail(error.message),
			onClose: (code, stderr) => this.handleClose(code, stderr),
		});
	}

	async startSession(
		modelId: string,
		thoughtLevel: AcpThoughtLevel | undefined,
		systemPrompt: string,
		prompt: AcpContentBlock[],
		signal: AbortSignal | undefined,
	): Promise<void> {
		this.setSignal(signal);
		if (this.stopping) return;

		await this.client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, { timeoutMs: HANDSHAKE_TIMEOUT_MS, signal });
		if (this.stopping) return;

		const sessionParams: Record<string, unknown> = {
			cwd: this.cwd,
			mcpServers: [this.bridge.mcpServerConfig],
			...(systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } } : {}),
		};
		const session = await this.client.request<AcpSessionNewResult>("session/new", sessionParams, { timeoutMs: HANDSHAKE_TIMEOUT_MS, signal });
		if (this.stopping) return;
		if (!session.sessionId) {
			throw new Error("agy ACP did not return a sessionId");
		}
		this.acpSessionId = session.sessionId;

		await this.client.request(
			"session/set_config_option",
			{ sessionId: this.acpSessionId, configId: "model", value: modelId },
			{ timeoutMs: HANDSHAKE_TIMEOUT_MS, signal },
		);
		if (thoughtLevel) {
			await this.client.request(
				"session/set_config_option",
				{ sessionId: this.acpSessionId, configId: "thought_level", value: thoughtLevel },
				{ timeoutMs: HANDSHAKE_TIMEOUT_MS, signal },
			);
		}
		if (this.stopping) return;

		this.sendPrompt(prompt);
	}

	canContinueTools(
		owner: symbol,
		sessionId: string | undefined,
		configuration: unknown,
		messages: Message[],
		results: ToolResultMessage[],
	): boolean {
		const conversation = conversationForReuse(messages);
		return !this.stopping && this.mode === "waiting-tools"
			&& owner === this.owner && !!sessionId && sessionId === this.sessionId
			&& isDeepStrictEqual(configuration, this.configuration)
			&& isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)
			&& conversation.length === this.conversation.length + this.admitted.length
			&& results.length === this.admitted.length
			&& new Set(results.map((r) => r.toolCallId)).size === results.length
			&& this.admitted.every((call) => results.some((r) => r.toolCallId === call.id && r.toolName === call.name));
	}

	continueToolTurn(
		turn: AntigravityTurn,
		messages: Message[],
		results: ToolResultMessage[],
		signal: AbortSignal | undefined,
	): void {
		removeLiveProcess(this);
		const admitted = this.admitted;
		this.admitted = [];
		this.toolCallIds = [];
		this.conversation = structuredClone(conversationForReuse(messages));
		this.turn = turn;
		this.turn.setContextWindow(this.contextWindow);
		this.setSignal(signal);
		if (this.stopping) return;
		for (const call of admitted) {
			const result = results.find((candidate) => candidate.toolCallId === call.id)!;
			this.bridge.resolveToolCall(call, result);
		}
		this.flushAdmissions();
	}

	canContinueUserTurn(
		owner: symbol,
		sessionId: string | undefined,
		configuration: unknown,
		messages: Message[],
	): Message | null {
		if (this.stopping || this.mode !== "idle" || !this.acpSessionId) return null;
		if (owner !== this.owner || !sessionId || sessionId !== this.sessionId) return null;
		if (!isDeepStrictEqual(configuration, this.configuration)) return null;
		const conversation = conversationForReuse(messages);
		if (conversation.length !== this.conversation.length + 1) return null;
		if (!isDeepStrictEqual(conversation.slice(0, this.conversation.length), this.conversation)) return null;
		const nonSystem = messages.filter((m) => m.role !== "system");
		const last = nonSystem[nonSystem.length - 1];
		return last?.role === "user" ? last : null;
	}

	continueUserTurn(
		turn: AntigravityTurn,
		messages: Message[],
		nextUserMessage: Message,
		signal: AbortSignal | undefined,
	): void {
		removeLiveProcess(this);
		this.turn = turn;
		this.turn.setContextWindow(this.contextWindow);
		this.conversation = structuredClone(conversationForReuse(messages));
		this.setSignal(signal);
		if (this.stopping) return;
		if (nextUserMessage.role !== "user") {
			this.fail("Expected user message for session continuation");
			return;
		}
		this.sendPrompt(toUnlabelledBlocks(nextUserMessage.content));
	}

	consumeFailure(owner: symbol, turn: AntigravityTurn): boolean {
		if (owner !== this.owner || !this.pendingError) return false;
		const message = this.pendingError;
		this.pendingError = undefined;
		this.kill();
		turn.fail(message, "error");
		return true;
	}

	flushAdmissions(): void {
		if (this.stopping || this.turn.finished) return;
		const pending = this.bridge.getPendingToolCalls();
		if (pending.length === 0) return;
		const calls: ToolCall[] = pending.map((call) => ({
			type: "toolCall",
			id: call.id,
			name: call.name,
			arguments: call.arguments,
		}));
		this.admitted = pending;
		this.toolCallIds = pending.map((call) => call.id);
		this.mode = "waiting-tools";
		this.turn.admit(calls);
		this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
		if (this.sessionId) {
			addLiveProcess(this);
		} else {
			this.kill();
		}
	}

	fail(message: string): void {
		if (this.sessionId && this.turn.finished && this.toolCallIds.length > 0) {
			this.pendingError = message;
		}
		this.turn.fail(message, "error");
		this.kill();
		if (this.pendingError) addLiveProcess(this);
	}

	kill(): void {
		removeLiveProcess(this);
		if (this.stopping || this.closed) return;
		this.stopping = true;
		if (this.acpSessionId) {
			this.client.notify("session/close", { sessionId: this.acpSessionId });
		}
		this.client.kill();
	}

	private sendPrompt(prompt: AcpContentBlock[]): void {
		if (!this.acpSessionId || this.stopping) return;
		this.client
			.request<AcpPromptResult>("session/prompt", { sessionId: this.acpSessionId, prompt })
			.then((result) => {
				if (this.stopping) return;
				this.turn.complete(result ?? {});
				this.conversation.push(...structuredClone(conversationForReuse([this.turn.getMessage()])));
				if (this.sessionId && !this.stopping && !this.closed) {
					this.mode = "idle";
					this.toolCallIds = [];
					addLiveProcess(this);
				} else {
					this.kill();
				}
			})
			.catch((error: unknown) => {
				if (this.stopping) return;
				const message = isAcpAuthError(error)
					? AntigravityError.NotSignedIn
					: error instanceof Error
						? error.message
						: String(error);
				this.fail(message);
			});
	}

	private handleNotification(method: string, params: Record<string, unknown>): void {
		if (this.stopping || method !== "session/update") return;
		const update = asObject(params.update);
		const kind = update.sessionUpdate;

		switch (kind) {
			case "agent_thought_chunk": {
				const content = asObject(update.content);
				if (content.type === "text" && typeof content.text === "string") {
					this.turn.appendThinking(content.text);
				}
				return;
			}
			case "agent_message_chunk": {
				const content = asObject(update.content);
				if (content.type === "text" && typeof content.text === "string") {
					this.turn.appendText(content.text);
				}
				return;
			}
			case "usage_update": {
				if (typeof update.size === "number" && update.size > 0) {
					this.contextWindow = update.size;
					this.turn.setContextWindow(update.size);
				}
				return;
			}
			case "tool_call_update": {
				const name = typeof update.name === "string" ? update.name : "";
				const status = typeof update.status === "string" ? update.status : "";
				// Fail closed if a non-bridge built-in tool somehow executes to completion.
				if (status === "completed" && name && !isBridgeToolName(name)) {
					this.fail("antigravity CLI executed an unsupported built-in tool");
				}
				return;
			}
		}
	}

	private handleRequest(id: AcpJsonRpcId, method: string, params: Record<string, unknown>): void {
		if (this.stopping) return;
		if (method !== "session/request_permission") {
			this.client.respondError(id, -32601, `Unsupported ACP client method: ${method}`);
			return;
		}
		const toolCall = asObject(params.toolCall);
		const rawName = typeof toolCall.name === "string" ? toolCall.name : "";
		const toolCallId = typeof toolCall.toolCallId === "string" ? toolCall.toolCallId : "";
		const options = Array.isArray(params.options) ? (params.options as Array<Record<string, unknown>>) : [];
		const allowOpt = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always") ?? options[0];
		const denyOpt = options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");

		const strippedName = isBridgeToolName(rawName) ? toolNameFromAcpMcp(rawName) : "";
		if (strippedName && this.declaredToolNames.has(strippedName) && toolCallId && allowOpt?.optionId) {
			const args = asObject(toolCall.rawInput ?? toolCall.args) as JsonObject;
			this.bridge.approvePermission({ id: toolCallId, name: strippedName, arguments: args });
			this.client.respond(id, { outcome: { outcome: "selected", optionId: allowOpt.optionId } });
			return;
		}

		// Deny any non-Twig built-in tool so the model recovers using Twig's MCP tools.
		if (denyOpt?.optionId) {
			this.client.respond(id, { outcome: { outcome: "selected", optionId: denyOpt.optionId } });
		} else {
			this.client.respond(id, { outcome: { outcome: "cancelled" } });
		}
	}

	private readonly abort = () => {
		if (this.acpSessionId && !this.stopping) {
			this.client.notify("session/cancel", { sessionId: this.acpSessionId });
		}
		this.turn.fail(ABORT_MESSAGE, "aborted");
		this.kill();
	};

	private setSignal(signal: AbortSignal | undefined): void {
		this.signal?.removeEventListener("abort", this.abort);
		this.signal = signal;
		signal?.addEventListener("abort", this.abort, { once: true });
		if (signal?.aborted) this.abort();
	}

	private handleClose(code: number | null, stderr: string): void {
		if (this.closed) return;
		this.closed = true;
		removeLiveProcess(this);
		if (this.pendingError) addLiveProcess(this);
		this.signal?.removeEventListener("abort", this.abort);
		if (stderr.trim()) console.error("agy CLI stderr:", stderr.trim());
		this.turn.fail(`agy ACP exited with code ${code}`, "error");
		Promise.all([
			this.bridge.close(),
			rm(this.cwd, { recursive: true, force: true }),
		]).catch((error: unknown) => {
			console.error("antigravity CLI cleanup failed:", error);
		});
	}
}

function tryContinueLiveProcess(
	turn: AntigravityTurn,
	owner: symbol,
	sessionId: string | undefined,
	configuration: unknown,
	messages: Message[],
	signal: AbortSignal | undefined,
): boolean {
	// 1. Mid-turn tool-call continuation
	const assistantIndex = messages.findLastIndex((m) => m.role === "assistant");
	const assistant = messages[assistantIndex];
	if (assistant?.role === "assistant") {
		const ids = assistant.content.flatMap((block) => (block.type === "toolCall" ? [block.id] : []));
		const toolProc = getLiveProcessForTools(ids, owner, sessionId);
		if (toolProc instanceof AntigravityProcess) {
			if (toolProc.consumeFailure(owner, turn)) return true;
			const trailing = messages.slice(assistantIndex + 1);
			const results = trailing.filter((m) => m.role === "toolResult");
			if (trailing.length === results.length && toolProc.canContinueTools(owner, sessionId, configuration, messages, results)) {
				toolProc.continueToolTurn(turn, messages, results, signal);
				return true;
			}
			toolProc.kill();
			return false;
		}
	}

	// 2. Cross-turn multi-turn session reuse
	const idleProc = getLiveProcessForSession(owner, sessionId);
	if (idleProc instanceof AntigravityProcess) {
		const nextUser = idleProc.canContinueUserTurn(owner, sessionId, configuration, messages);
		if (nextUser) {
			idleProc.continueUserTurn(turn, messages, nextUser, signal);
			return true;
		}
		// History diverged (edit, retry, compaction, model/config change): retire old process and replay fresh.
		idleProc.kill();
	}

	return false;
}

async function startProcess(
	runAntigravity: RunAntigravity,
	turn: AntigravityTurn,
	model: Model<Api>,
	context: TranscriptContext,
	options: SimpleStreamOptions | undefined,
	owner: symbol,
	configuration: unknown,
	env: NodeJS.ProcessEnv,
	thoughtLevel: AcpThoughtLevel | undefined,
): Promise<void> {
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		return;
	}
	const input = toAntigravityInput(context.messages);
	const declaredTools = new Set(getCurrentTools(context.messages).map((t) => t.name));

	let acpProcess: AntigravityProcess | undefined;
	const bridge = await createAntigravityToolBridge(input.tools, {
		onCall: () => acpProcess?.flushAdmissions(),
		onError: (error) => acpProcess?.fail(error.message),
	});
	let cwd: string;
	try {
		cwd = await mkdtemp(join(tmpdir(), "antigravity-cwd-"));
	} catch (error) {
		await bridge.close();
		throw error;
	}
	if (options?.signal?.aborted) {
		turn.fail(ABORT_MESSAGE, "aborted");
		await Promise.all([bridge.close(), rm(cwd, { recursive: true, force: true })]);
		return;
	}

	let child: Awaited<ReturnType<RunAntigravity>>;
	try {
		child = await runAntigravity([...ANTIGRAVITY_ACP_ARGS], { cwd, env, signal: options?.signal });
	} catch (error) {
		await Promise.all([bridge.close(), rm(cwd, { recursive: true, force: true })]);
		throw error;
	}

	if (!child) {
		turn.fail(AntigravityError.CliNotFound, "error");
		await Promise.all([bridge.close(), rm(cwd, { recursive: true, force: true })]);
		return;
	}

	acpProcess = new AntigravityProcess(
		child,
		bridge,
		cwd,
		turn,
		owner,
		options?.sessionId,
		configuration,
		structuredClone(conversationForReuse(context.messages)),
		declaredTools,
	);
	try {
		await acpProcess.startSession(model.id, thoughtLevel, input.systemPrompt, input.prompt, options?.signal);
	} catch (error) {
		const message = options?.signal?.aborted
			? ABORT_MESSAGE
			: isAcpAuthError(error)
				? AntigravityError.NotSignedIn
				: error instanceof Error
					? error.message
					: START_FAILED_MESSAGE;
		acpProcess.fail(message);
	}
}

export function createAntigravityStreamFunction(
	runAntigravity: RunAntigravity = createAntigravityLauncher(),
): StreamFunction<Api, SimpleStreamOptions> {
	const owner = Symbol("antigravity stream owner");
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const turn = new AntigravityTurn(stream, model);

		const env = externalCliEnv();
		const thoughtLevel = toThoughtLevel(model, options?.reasoning);
		const configuration = { request: configurationForReuse(model, context, thoughtLevel), env };

		if (tryContinueLiveProcess(turn, owner, options?.sessionId, configuration, context.messages, options?.signal)) {
			return stream;
		}

		startProcess(runAntigravity, turn, model, context, options, owner, configuration, env, thoughtLevel).catch((error: unknown) => {
			console.error("antigravity CLI turn failed:", error);
			turn.fail(
				options?.signal?.aborted
					? ABORT_MESSAGE
					: error instanceof AntigravityLaunchError
						? error.message
						: START_FAILED_MESSAGE,
				options?.signal?.aborted ? "aborted" : "error",
			);
		});

		return stream;
	};
}

export const streamAntigravity = createAntigravityStreamFunction();
