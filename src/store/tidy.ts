/**
 * Tidy-graph proposals (core/graph-tidy.ts): config.TIDY_FILE, one JSON
 * object { runAt, proposals }. Rewritten whole by the tidy service; an
 * absent or corrupt file reads as "never run".
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TIDY_FILE } from "../../config.ts";
import type { TidyProposal } from "../core/graph-tidy.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

export interface TidyState {
	runAt?: string;
	proposals: TidyProposal[];
}

export interface TidyStore {
	read(): TidyState;
	write(state: TidyState): void;
}

const KINDS = new Set(["merge", "split", "connect"]);
const STATUSES = new Set(["pending", "applied", "skipped"]);

function isProposal(v: unknown): v is TidyProposal {
	if (typeof v !== "object" || v === null) return false;
	const p = v as Partial<TidyProposal>;
	return typeof p.id === "string" && typeof p.reason === "string" && typeof p.createdAt === "string" &&
		STATUSES.has(p.status as string) && typeof p.change === "object" && p.change !== null && KINDS.has(p.change.kind);
}

export function createTidyStore(file: string = TIDY_FILE): TidyStore {
	return {
		read() {
			try {
				const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TidyState>;
				return {
					...(typeof parsed.runAt === "string" ? { runAt: parsed.runAt } : {}),
					proposals: Array.isArray(parsed.proposals) ? parsed.proposals.filter(isProposal) : [],
				};
			} catch {
				return { proposals: [] };
			}
		},
		write(state) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomicSync(file, JSON.stringify(state, null, "\t"));
		},
	};
}

export const tidyStore = createTidyStore();
