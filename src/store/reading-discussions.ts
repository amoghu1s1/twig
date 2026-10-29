/**
 * ReadingDiscussionStore — the fs JSON adapter: one file per discussed
 * reading in data/reading-discussions/ (docs/readings.md §14). Implements
 * core/ports.ts ReadingDiscussionStore. Idioms (the reading store's): sync
 * fs, id-guarded filenames, tab-indented JSON, notify-after-write on the
 * events channel. mutateDiscussion contains no awaits, so it is atomic
 * within the event loop.
 *
 * Schema stamp: every write stamps the current version; a record stamped
 * NEWER than this build is refused on read and never rewritten.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ReadingDiscussionStore } from "../core/ports.ts";
import { CURRENT_DISCUSSION_VERSION, type ReadingDiscussionRecord } from "../core/contracts.ts";

function discussionsDir(): string {
	return path.join(PATHS.data, "reading-discussions");
}

function discussionFile(readingId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(readingId)) throw new Error(`Invalid reading id: ${readingId}`);
	return path.join(discussionsDir(), `${readingId}.json`);
}

function write(record: ReadingDiscussionRecord): void {
	fs.mkdirSync(discussionsDir(), { recursive: true });
	const file = discussionFile(record.readingId);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ ...record, version: CURRENT_DISCUSSION_VERSION }, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

function getDiscussion(readingId: string): ReadingDiscussionRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(discussionFile(readingId), "utf-8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_DISCUSSION_VERSION) {
		console.error(`[discussion ${readingId}] stamped with schema version ${v} > ${CURRENT_DISCUSSION_VERSION} — refusing to read it`);
		return null;
	}
	const r = parsed as ReadingDiscussionRecord;
	if (typeof r.readingId !== "string" || !r.side || !Array.isArray(r.side.exchanges) || !Array.isArray(r.threads)) return null;
	return r;
}

function mutateDiscussion(
	readingId: string,
	change: (current: ReadingDiscussionRecord | null) => ReadingDiscussionRecord | null,
): ReadingDiscussionRecord | null {
	const next = change(getDiscussion(readingId));
	if (!next) return null;
	const stamped: ReadingDiscussionRecord = { ...next, readingId, updatedAt: new Date().toISOString() };
	write(stamped);
	emit("discussion-changed", { readingId });
	return stamped;
}

function listDiscussions(): ReadingDiscussionRecord[] {
	let files: string[];
	try {
		files = fs.readdirSync(discussionsDir());
	} catch {
		return [];
	}
	return files
		.filter((f) => f.endsWith(".json"))
		.map((f) => getDiscussion(f.slice(0, -5)))
		.filter((r): r is ReadingDiscussionRecord => r !== null);
}

function deleteDiscussion(readingId: string): boolean {
	try {
		fs.unlinkSync(discussionFile(readingId));
	} catch {
		return false;
	}
	emit("discussion-changed", { readingId });
	return true;
}

export const readingDiscussionStore: ReadingDiscussionStore = {
	getDiscussion,
	mutateDiscussion,
	listDiscussions,
	deleteDiscussion,
};
