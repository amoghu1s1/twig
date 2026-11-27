import { antigravityInstallationResponse } from "@/src/server";

/** Installation/version + ACP model catalog probe for Antigravity CLI. */
export async function GET(request: Request) {
	return antigravityInstallationResponse(request);
}
