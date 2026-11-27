import { createProvider, type Api, type Provider, type SimpleStreamOptions, type StreamFunction } from "@earendil-works/pi-ai";
import { ANTIGRAVITY_LABEL } from "../../core/contracts/antigravity.ts";
import { ANTIGRAVITY_PROVIDER } from "./constants.ts";

export function createAntigravityProvider(streamSimple: StreamFunction<Api, SimpleStreamOptions>): Provider {
	return createProvider({
		id: ANTIGRAVITY_PROVIDER,
		name: ANTIGRAVITY_LABEL,
		auth: { apiKey: { name: "Antigravity CLI", resolve: async () => ({ auth: {}, source: "agy CLI" }) } },
		// Models are discovered dynamically from `agy acp` via catalog.ts (like ChatGPT/subscriptions).
		models: [],
		api: { stream: streamSimple, streamSimple },
	});
}
