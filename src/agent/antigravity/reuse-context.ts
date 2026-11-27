import type { Api, Message, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

/** Compare model-visible history, not app IDs, timestamps, usage, or Pi's added thinkingLevel. */
export function conversationForReuse(messages: Message[]): unknown[] {
	return messages.flatMap((message): unknown[] => {
		switch (message.role) {
			case "system": return [];
			case "user": return [{ role: message.role, content: message.content }];
			case "assistant": return [{ role: message.role, content: message.content }];
			case "toolResult": return [{
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				content: message.content,
				isError: message.isError,
			}];
		}
	});
}

export function configurationForReuse(model: Model<Api>, context: TranscriptContext, thoughtLevel: string | undefined): unknown {
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const tools = getCurrentTools(context.messages);
	return JSON.parse(JSON.stringify({ model, thoughtLevel, systemPrompt, tools })) as unknown;
}
