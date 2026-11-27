import type { ImageContent, Message, TextContent, Tool } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";

export type AcpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string };

export type AntigravityInput = {
	systemPrompt: string;
	tools: Tool[];
	prompt: AcpContentBlock[];
};

type ReplayPart = string | ImageContent;

function toImageBlock(image: ImageContent): AcpContentBlock {
	return { type: "image", mimeType: image.mimeType, data: image.data };
}

function getLabelledParts(label: string, content: string | (TextContent | ImageContent)[]): ReplayPart[] {
	if (typeof content === "string") return [`${label}\n${content}`];

	const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	const images = content.filter((block) => block.type === "image");

	return [text ? `${label}\n${text}` : label, ...images];
}

function getReplayParts(message: Message): ReplayPart[] {
	switch (message.role) {
		case "system":
			return [];
		case "user":
			return getLabelledParts("[user]", message.content);
		case "assistant":
			return message.content.flatMap((block) => {
				if (block.type === "text") return [`[assistant]\n${block.text}`];
				if (block.type === "toolCall") return [`[tool call ${block.name}] ${JSON.stringify(block.arguments)}`];
				return [];
			});
		case "toolResult": {
			const label = message.isError ? `[tool result ${message.toolName} error]` : `[tool result ${message.toolName}]`;
			return getLabelledParts(label, message.content);
		}
	}
}

function toContentBlocks(parts: ReplayPart[]): AcpContentBlock[] {
	const blocks: AcpContentBlock[] = [];
	let pendingText: string[] = [];

	const flushText = () => {
		if (pendingText.length > 0) blocks.push({ type: "text", text: pendingText.join("\n\n") });
		pendingText = [];
	};

	for (const part of parts) {
		if (typeof part === "string") {
			pendingText.push(part);
		} else {
			flushText();
			blocks.push(toImageBlock(part));
		}
	}

	flushText();
	return blocks;
}

export function toUnlabelledBlocks(content: string | (TextContent | ImageContent)[]): AcpContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((block) => (block.type === "text" ? { type: "text", text: block.text } : toImageBlock(block)));
}

function toPromptBlocks(conversation: Message[]): AcpContentBlock[] {
	const [first] = conversation;
	if (conversation.length === 1 && first?.role === "user") return toUnlabelledBlocks(first.content);
	return toContentBlocks(conversation.flatMap(getReplayParts));
}

export function toAntigravityInput(messages: Message[]): AntigravityInput {
	const conversation = messages.filter((message) => message.role !== "system");
	return {
		systemPrompt: getCurrentSystemPrompt(messages),
		tools: getCurrentTools(messages),
		prompt: toPromptBlocks(conversation),
	};
}
