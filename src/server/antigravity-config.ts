import { getAntigravityBinary } from "../agent/antigravity/binary.ts";
import { settingsStore } from "../store/settings.ts";

/** Fresh admission state, not a process-wide cache. Existing runs retain
 * their engines; only new chat/job/extraction/compaction admissions consult it. */
export function antigravityEnabled(): boolean {
	return settingsStore.readSettings()?.antigravity?.enabled === true;
}

/** Installation/opt-in availability only, never authenticated readiness. */
export function antigravityAvailable(): boolean {
	return antigravityEnabled() && getAntigravityBinary() !== null;
}
