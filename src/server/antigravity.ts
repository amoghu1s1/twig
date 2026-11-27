import { refreshAntigravityModels } from "../agent/antigravity/catalog.ts";
import { inspectAntigravityVersion } from "../agent/antigravity/installation.ts";
import type { AntigravityStatus } from "../core/contracts/antigravity.ts";
import { antigravityEnabled } from "./antigravity-config.ts";
import { initAuthEnv } from "./keys.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

/** The Settings status seam: initialize provenance before any child env is copied,
 * check `agy --version`, and probe `agy acp` to discover available models. */
export async function antigravityInstallationStatus(
	inspectVersion = inspectAntigravityVersion,
	refreshCatalog = refreshAntigravityModels,
): Promise<AntigravityStatus> {
	initAuthEnv();
	const versionCheck = await inspectVersion();
	if (versionCheck.state !== "meets-minimum") {
		return {
			state: versionCheck.state,
			version: versionCheck.version,
			minimumVersion: versionCheck.minimumVersion,
			modelCount: 0,
		};
	}

	const catalog = await refreshCatalog();
	if (!catalog.ok) {
		return {
			state: catalog.notSignedIn ? "not-signed-in" : "version-unchecked",
			version: versionCheck.version,
			minimumVersion: versionCheck.minimumVersion,
			modelCount: 0,
		};
	}

	return {
		state: "ready",
		version: versionCheck.version,
		minimumVersion: versionCheck.minimumVersion,
		modelCount: catalog.models.length,
	};
}

/** Same-origin browser intent, not user authentication. No CORS grants. */
export async function antigravityInstallationResponse(
	request: Request,
	inspect = antigravityInstallationStatus,
	enabled = antigravityEnabled,
): Promise<Response> {
	const origin = subscriptionRequestOrigin(request);
	const supplied = request.headers.get("origin");
	const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
	if (
		request.method !== "GET"
		|| !origin
		|| request.headers.get("x-learnharness-antigravity") !== "1"
		|| request.headers.get("sec-fetch-site") === "cross-site"
		|| (supplied !== null && supplied !== origin)
	) {
		return Response.json({ error: "Antigravity checks require a same-origin Twig request." }, { status: 403, headers });
	}
	if (!enabled()) return Response.json({ error: "Antigravity is disabled." }, { status: 403, headers });
	return Response.json(await inspect(), { headers });
}
