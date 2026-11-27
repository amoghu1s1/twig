import assert from "node:assert/strict";
import { test } from "node:test";
import { ANTIGRAVITY_MINIMUM_VERSION } from "../src/core/contracts/antigravity.ts";
import { inspectAntigravityVersion } from "../src/agent/antigravity/installation.ts";
import { antigravityInstallationStatus } from "../src/server/antigravity.ts";

test("inspectAntigravityVersion handles not-found, meets-minimum, update-required, and malformed output", async () => {
	const notFound = await inspectAntigravityVersion(() => null, async () => "1.5.18");
	assert.deepEqual(notFound, { state: "not-found", version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION });

	const meets = await inspectAntigravityVersion(() => "/usr/bin/agy", async () => "1.5.18\n");
	assert.deepEqual(meets, { state: "meets-minimum", version: "1.5.18", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION });

	const newer = await inspectAntigravityVersion(() => "/usr/bin/agy", async () => "1.6.0 (Antigravity)");
	assert.deepEqual(newer, { state: "meets-minimum", version: "1.6.0", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION });

	const old = await inspectAntigravityVersion(() => "/usr/bin/agy", async () => "1.5.17");
	assert.deepEqual(old, { state: "update-required", version: "1.5.17", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION });

	const bad = await inspectAntigravityVersion(() => "/usr/bin/agy", async () => "unexpected output");
	assert.deepEqual(bad, { state: "version-unchecked", version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION });

	const failed = await inspectAntigravityVersion(() => "/usr/bin/agy", async () => { throw new Error("timeout"); });
	assert.deepEqual(failed, { state: "version-unchecked", version: null, minimumVersion: ANTIGRAVITY_MINIMUM_VERSION });
});

test("antigravityInstallationStatus reports ready with modelCount or not-signed-in from catalog probe", async () => {
	const ready = await antigravityInstallationStatus(
		async () => ({ state: "meets-minimum", version: "1.5.18", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION }),
		async () => ({ ok: true, models: [{ id: "gemini-4-neon" } as never, { id: "gemini-3.8-flash" } as never] }),
	);
	assert.deepEqual(ready, { state: "ready", version: "1.5.18", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION, modelCount: 2 });

	const signedOut = await antigravityInstallationStatus(
		async () => ({ state: "meets-minimum", version: "1.5.18", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION }),
		async () => ({ ok: false, notSignedIn: true, error: "authentication required" }),
	);
	assert.deepEqual(signedOut, { state: "not-signed-in", version: "1.5.18", minimumVersion: ANTIGRAVITY_MINIMUM_VERSION, modelCount: 0 });
});
