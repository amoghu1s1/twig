import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { externalCliEnv } from "../../core/auth-env.ts";
import { AcpClient, AcpRpcError } from "./acp-client.ts";
import { ANTIGRAVITY_API, ANTIGRAVITY_PROVIDER } from "./constants.ts";
import { ANTIGRAVITY_ACP_ARGS, createAntigravityLauncher, type RunAntigravity } from "./launch.ts";

const PROBE_TIMEOUT_MS = 15_000;
const DEFAULT_CONTEXT_WINDOW = 1_048_576;
const DEFAULT_MAX_TOKENS = 65_536;

type AcpConfigOption = {
	id?: unknown;
	options?: Array<{ value?: unknown; name?: unknown }>;
};

type AcpAvailableModel = {
	modelId?: unknown;
	name?: unknown;
};

export interface AcpSessionNewResult {
	sessionId?: string;
	models?: {
		availableModels?: AcpAvailableModel[];
		currentModelId?: string;
	};
	configOptions?: AcpConfigOption[];
}

const THOUGHT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

function buildThinkingLevelMap(
	modelId: string,
	availableIds: ReadonlySet<string>,
): { reasoning: boolean; thinkingLevelMap?: Model<Api>["thinkingLevelMap"] } {
	const supported = THOUGHT_LEVELS.filter((level) => availableIds.has(`${modelId}-${level}`));
	if (supported.length === 0) {
		return { reasoning: false };
	}
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: supported.includes("low") ? "low" : null,
			medium: supported.includes("medium") ? "medium" : null,
			high: supported.includes("high") ? "high" : null,
			xhigh: supported.includes("xhigh") ? "xhigh" : null,
			max: null,
		},
	};
}

/** Parse `session/new` response into pi-ai Model entries. */
export function parseAcpCatalog(result: AcpSessionNewResult, contextWindow = DEFAULT_CONTEXT_WINDOW): Model<Api>[] {
	const availableIds = new Set<string>();
	for (const entry of result.models?.availableModels ?? []) {
		if (typeof entry.modelId === "string" && entry.modelId.trim()) {
			availableIds.add(entry.modelId.trim());
		}
	}

	const modelOption = (result.configOptions ?? []).find((opt) => opt.id === "model");
	const baseOptions = (modelOption?.options ?? []).filter(
		(opt): opt is { value: string; name?: string } => typeof opt.value === "string" && opt.value.trim().length > 0,
	);

	// Fallback if configOptions[id="model"] is absent: use availableModels directly.
	const entries: Array<{ id: string; name: string }> = baseOptions.length > 0
		? baseOptions.map((opt) => ({
			id: opt.value.trim(),
			name: typeof opt.name === "string" && opt.name.trim() ? opt.name.trim() : opt.value.trim(),
		}))
		: (result.models?.availableModels ?? [])
			.filter((m): m is { modelId: string; name?: string } => typeof m.modelId === "string" && m.modelId.trim().length > 0)
			.map((m) => ({
				id: m.modelId.trim(),
				name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : m.modelId.trim(),
			}));

	const seen = new Set<string>();
	const models: Model<Api>[] = [];
	for (const entry of entries) {
		if (seen.has(entry.id)) continue;
		seen.add(entry.id);
		const thinking = buildThinkingLevelMap(entry.id, availableIds);
		models.push({
			id: entry.id,
			name: entry.name,
			api: ANTIGRAVITY_API,
			provider: ANTIGRAVITY_PROVIDER,
			baseUrl: "",
			input: ["text", "image"],
			// Placeholders only; server pricing and UI report unpriced / CLI billing.
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			reasoning: thinking.reasoning,
			...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
			contextWindow,
			maxTokens: DEFAULT_MAX_TOKENS,
		});
	}
	return models;
}

export function isAcpAuthError(error: unknown): boolean {
	const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
	if (error instanceof AcpRpcError && error.code === -32000) {
		if (/auth|login|sign.?in|credential|unauthenticated|unauthorized|token/.test(message)) return true;
	}
	return /not signed in|authentication|unauthenticated|unauthorized|please log ?in|login required|oauth/.test(message);
}

type CatalogStore = {
	models: Model<Api>[];
	inflight: Promise<RefreshAntigravityCatalogResult> | null;
};

const CATALOG_KEY = Symbol.for("twig.antigravity.catalog");
function catalogStore(): CatalogStore {
	const g = globalThis as Record<symbol, CatalogStore | undefined>;
	if (!g[CATALOG_KEY]) g[CATALOG_KEY] = { models: [], inflight: null };
	return g[CATALOG_KEY]!;
}

export type RefreshAntigravityCatalogResult =
	| { ok: true; models: Model<Api>[] }
	| { ok: false; notSignedIn: boolean; error: string };

export function antigravityModels(): readonly Model<Api>[] {
	return catalogStore().models;
}

export function antigravityModel(id: string): Model<Api> | undefined {
	return catalogStore().models.find((m) => m.id === id);
}

/** Test seam for deterministic offline tests. */
export function setAntigravityModelsForTest(models: Model<Api>[]): void {
	catalogStore().models = [...models];
}

async function runCatalogProbe(runAntigravity: RunAntigravity): Promise<RefreshAntigravityCatalogResult> {
	const cwd = await mkdtemp(join(tmpdir(), "antigravity-probe-"));
	let client: AcpClient | undefined;
	try {
		const child = await runAntigravity([...ANTIGRAVITY_ACP_ARGS], { cwd, env: externalCliEnv() });
		if (!child) {
			catalogStore().models = [];
			return { ok: false, notSignedIn: false, error: "agy CLI not found" };
		}

		let reportedContextWindow = DEFAULT_CONTEXT_WINDOW;
		client = new AcpClient(child, {
			onNotification: (method, params) => {
				if (method !== "session/update") return;
				const update = params.update;
				if (update && typeof update === "object" && !Array.isArray(update)) {
					const u = update as Record<string, unknown>;
					if (u.sessionUpdate === "usage_update" && typeof u.size === "number" && u.size > 0) {
						reportedContextWindow = u.size;
					}
				}
			},
		});

		await client.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, { timeoutMs: PROBE_TIMEOUT_MS });
		const session = await client.request<AcpSessionNewResult>(
			"session/new",
			{ cwd, mcpServers: [] },
			{ timeoutMs: PROBE_TIMEOUT_MS },
		);

		const models = parseAcpCatalog(session, reportedContextWindow);
		if (session.sessionId) {
			await client.request("session/close", { sessionId: session.sessionId }, { timeoutMs: 2_000 }).catch(() => {});
		}
		catalogStore().models = models;
		return { ok: true, models };
	} catch (error) {
		const notSignedIn = isAcpAuthError(error);
		if (notSignedIn) catalogStore().models = [];
		return {
			ok: false,
			notSignedIn,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		client?.kill();
		await rm(cwd, { recursive: true, force: true }).catch(() => {});
	}
}

export function refreshAntigravityModels(
	runAntigravity: RunAntigravity = createAntigravityLauncher(),
): Promise<RefreshAntigravityCatalogResult> {
	const store = catalogStore();
	if (store.inflight) return store.inflight;
	const promise = runCatalogProbe(runAntigravity).finally(() => {
		if (store.inflight === promise) store.inflight = null;
	});
	store.inflight = promise;
	return promise;
}
