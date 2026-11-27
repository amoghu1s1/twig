export const ANTIGRAVITY_PROVIDER = "antigravity";
/** Human label for the Antigravity provider in model menus and refusals. */
export const ANTIGRAVITY_LABEL = "Antigravity";

/** Installation/version and ACP model-catalog probe status. */
export interface AntigravityStatus {
	state: "not-found" | "update-required" | "version-unchecked" | "not-signed-in" | "ready";
	version: string | null;
	minimumVersion: string;
	modelCount: number;
}

// 1.5.18 is the verified baseline supporting `agy acp --stdio --include-default-customizations=false`,
// loopback HTTP MCP servers, and `_meta.antigravity.systemPrompt.append`.
export const ANTIGRAVITY_MINIMUM_VERSION = "1.5.18";
