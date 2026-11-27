export { ANTIGRAVITY_PROVIDER } from "../../core/contracts/antigravity.ts";

export const ANTIGRAVITY_API = "antigravity-acp";

export enum AntigravityError {
	CliNotFound = "agy CLI not found",
	NotSignedIn = "Antigravity CLI is not signed in. Run `agy` in your terminal to sign in.",
}
