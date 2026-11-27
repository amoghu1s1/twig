import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";

import type { ImageContent, JsonObject, TextContent, Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type CallToolResult,
	type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";

export const BRIDGE_SERVER_NAME = "learnharness";

// agy acp names MCP tools `mcp_<server>_<tool>` (single underscores).
const ACP_MCP_TOOL_PREFIX = `mcp_${BRIDGE_SERVER_NAME}_`;
const LOOPBACK_HOST = "127.0.0.1";
const TOKEN_BYTES = 32;

export type PendingToolCall = { id: string; name: string; arguments: JsonObject };

export type AcpMcpServerConfig = {
	type: "http";
	name: string;
	url: string;
	headers: Array<{ name: string; value: string }>;
};

type BridgeCallbacks = {
	onCall(): void;
	onError(error: Error): void;
	onCancel?(call: PendingToolCall): void;
};

type ApprovedPermission = {
	id: string;
	name: string;
	arguments: JsonObject;
};

export type AntigravityToolBridge = {
	mcpServerConfig: AcpMcpServerConfig;
	approvePermission(call: ApprovedPermission): void;
	resolveToolCall(call: PendingToolCall, result: ToolResultMessage): void;
	getPendingToolCalls(): PendingToolCall[];
	close(): Promise<void>;
};

export function isBridgeToolName(acpToolName: string): boolean {
	return acpToolName.startsWith(ACP_MCP_TOOL_PREFIX);
}

export function toolNameFromAcpMcp(acpToolName: string): string {
	return acpToolName.startsWith(ACP_MCP_TOOL_PREFIX)
		? acpToolName.slice(ACP_MCP_TOOL_PREFIX.length)
		: acpToolName;
}

/** agy injects a `toolSummary` field into ACP tool_call args that is stripped before MCP tools/call. */
function normalizeAcpArgs(args: JsonObject): JsonObject {
	if (!("toolSummary" in args)) return args;
	const copy: JsonObject = { ...args };
	delete copy.toolSummary;
	return copy;
}

function toMcpContent(block: TextContent | ImageContent): CallToolResult["content"][number] {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text };
		case "image":
			return { type: "image", data: block.data, mimeType: block.mimeType };
	}
}

function toCallToolResult(result: ToolResultMessage): CallToolResult {
	return { content: result.content.map(toMcpContent), isError: result.isError };
}

function toMcpTool(tool: Tool): McpTool {
	return { name: tool.name, description: tool.description, inputSchema: tool.parameters as McpTool["inputSchema"] };
}

class ToolCallQueue {
	private readonly results = new Map<PendingToolCall, (result: CallToolResult) => void>();

	add(call: PendingToolCall, signal: AbortSignal, onCancel?: (call: PendingToolCall) => void): Promise<CallToolResult> {
		return new Promise<CallToolResult>((resolve) => {
			const cancel = () => {
				const settle = this.results.get(call);
				if (!settle) return;
				settle({ content: [{ type: "text", text: "MCP request cancelled" }], isError: true });
				onCancel?.(call);
			};
			this.results.set(call, (result) => {
				this.results.delete(call);
				signal.removeEventListener("abort", cancel);
				resolve(result);
			});
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) cancel();
		});
	}

	resolve(call: PendingToolCall, result: ToolResultMessage): void {
		this.results.get(call)?.(toCallToolResult(result));
	}

	list(): PendingToolCall[] {
		return [...this.results.keys()];
	}

	clear(): void {
		for (const settle of this.results.values()) {
			settle({ content: [{ type: "text", text: "MCP bridge closed" }], isError: true });
		}
		this.results.clear();
	}
}

function createMcpServer(
	tools: Tool[],
	queue: ToolCallQueue,
	approved: ApprovedPermission[],
	callbacks?: BridgeCallbacks,
): Server {
	const server = new Server({ name: BRIDGE_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: tools.map(toMcpTool) }));

	const seenIds = new Set<string>();
	server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
		const name = request.params.name;
		if (!tools.some((tool) => tool.name === name)) {
			const error = new McpError(ErrorCode.InvalidParams, "antigravity CLI requested an undeclared harness tool");
			callbacks?.onError(error);
			throw error;
		}
		const args = (request.params.arguments ?? {}) as JsonObject;
		const matchIndex = approved.findIndex(
			(entry) => entry.name === name
				&& !seenIds.has(entry.id)
				&& (isDeepStrictEqual(normalizeAcpArgs(entry.arguments), args) || isDeepStrictEqual(entry.arguments, args)),
		);
		if (matchIndex === -1) {
			const error = new McpError(ErrorCode.InvalidParams, "antigravity CLI compatibility error: MCP call did not match an approved permission request");
			callbacks?.onError(error);
			throw error;
		}
		const [matched] = approved.splice(matchIndex, 1);
		seenIds.add(matched!.id);
		const result = queue.add({ id: matched!.id, name, arguments: args }, extra.signal, callbacks?.onCancel);
		callbacks?.onCall();
		return result;
	});

	return server;
}

function isAuthorized(header: string | undefined, expected: Buffer): boolean {
	if (header === undefined) return false;
	const actual = Buffer.from(header);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createHttpServer(transport: StreamableHTTPServerTransport, authorization: string): http.Server {
	const expected = Buffer.from(authorization);

	return http.createServer((req, res) => {
		// agy probes OAuth protected-resource metadata without auth before sending Bearer headers.
		if (req.url?.startsWith("/.well-known/")) {
			res.writeHead(404).end();
			return;
		}
		if (!isAuthorized(req.headers.authorization, expected)) {
			res.writeHead(401).end();
			return;
		}

		transport.handleRequest(req, res).catch((error: unknown) => {
			console.error("antigravity tool bridge request failed", error);
			if (!res.headersSent) res.writeHead(500);
			res.end();
		});
	});
}

function listen(server: http.Server): Promise<AddressInfo> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, LOOPBACK_HOST, () => resolve(server.address() as AddressInfo));
	});
}

function closeHttpServer(server: http.Server): Promise<void> {
	server.closeAllConnections();
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

export async function createAntigravityToolBridge(
	tools: Tool[],
	callbacks?: BridgeCallbacks,
): Promise<AntigravityToolBridge> {
	const authorization = `Bearer ${randomBytes(TOKEN_BYTES).toString("hex")}`;
	const queue = new ToolCallQueue();
	const approved: ApprovedPermission[] = [];
	const mcpServer = createMcpServer(tools, queue, approved, callbacks);
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
	await mcpServer.connect(transport);

	const httpServer = createHttpServer(transport, authorization);
	let port: number;
	try {
		({ port } = await listen(httpServer));
	} catch (error) {
		await mcpServer.close();
		throw error;
	}

	return {
		mcpServerConfig: {
			type: "http",
			name: BRIDGE_SERVER_NAME,
			url: `http://${LOOPBACK_HOST}:${port}/mcp`,
			headers: [{ name: "Authorization", value: authorization }],
		},
		approvePermission: (call) => {
			approved.push(call);
		},
		resolveToolCall: (call, result) => queue.resolve(call, result),
		getPendingToolCalls: () => queue.list(),
		close: async () => {
			approved.length = 0;
			queue.clear();
			await mcpServer.close();
			await closeHttpServer(httpServer);
		},
	};
}
