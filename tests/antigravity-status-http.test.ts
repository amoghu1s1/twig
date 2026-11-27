import assert from "node:assert/strict";
import { test } from "node:test";
import { ANTIGRAVITY_MINIMUM_VERSION } from "../src/core/contracts/antigravity.ts";
import { antigravityInstallationResponse as respond } from "../src/server/antigravity.ts";

const antigravityInstallationResponse: typeof respond = (request, inspect) => respond(request, inspect, () => true);

function request(headers: Record<string, string> = {}) {
	return new Request("http://localhost:3000/api/antigravity", {
		headers: { "x-learnharness-antigravity": "1", ...headers },
	});
}

const status = { state: "ready" as const, version: "1.5.18", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION, modelCount: 5 };

for (const headers of [
	{ origin: "https://attacker.invalid" },
	{ "sec-fetch-site": "cross-site" },
	{ origin: "http://localhost:3000", "sec-fetch-site": "cross-site" },
	{ origin: "null" },
	{ "x-learnharness-antigravity": "" },
] as Record<string, string>[]) {
	test(`unsafe Antigravity status request ${JSON.stringify(headers)} never invokes probe`, async () => {
		let probes = 0;
		const response = await antigravityInstallationResponse(request(headers), async () => { probes++; return status; });
		assert.equal(response.status, 403);
		assert.equal(probes, 0);
		assert.equal(response.headers.get("access-control-allow-origin"), null);
	});
}

test("disabled Antigravity opt-in never starts a probe", async () => {
	let probes = 0;
	const response = await respond(request(), async () => { probes++; return status; }, () => false);
	assert.equal(response.status, 403);
	assert.equal(probes, 0);
});

test("legitimate same-origin GET returns status with no-store", async () => {
	let probes = 0;
	const response = await antigravityInstallationResponse(
		request({ origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }),
		async () => { probes++; return status; },
	);
	assert.equal(response.status, 200);
	assert.equal(probes, 1);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.deepEqual(await response.json(), status);
});
