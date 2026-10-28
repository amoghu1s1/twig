/**
 * ReadingStore — the fs JSON adapter: one file per reading in
 * data/readings/ (docs/readings.md). Implements core/ports.ts ReadingStore.
 * Idioms (the job store's): sync fs, id-guarded filenames, tab-indented
 * JSON, notify-after-write on the events channel. Read-modify-write
 * sections contain no awaits, so they are atomic within the event loop.
 *
 * Schema stamp (the chat store's discipline): every write stamps the
 * current version; a record stamped NEWER than this build is refused on
 * read and never rewritten.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { emit } from "../core/events.ts";
import type { ReadingStore } from "../core/ports.ts";
import { CURRENT_READING_VERSION, type ReadingRecord } from "../core/contracts.ts";

function readingsDir(): string {
	return path.join(PATHS.data, "readings");
}

function readingFile(id: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid reading id: ${id}`);
	return path.join(readingsDir(), `${id}.json`);
}

function write(record: ReadingRecord): void {
	fs.mkdirSync(readingsDir(), { recursive: true });
	const file = readingFile(record.id);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ ...record, version: CURRENT_READING_VERSION }, null, "\t"), "utf-8");
	fs.renameSync(tmp, file);
}

function getReading(id: string): ReadingRecord | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(readingFile(id), "utf-8"));
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const v = (parsed as { version?: unknown }).version;
	if (typeof v === "number" && v > CURRENT_READING_VERSION) {
		console.error(`[reading ${id}] stamped with schema version ${v} > ${CURRENT_READING_VERSION} — refusing to read it`);
		return null;
	}
	const r = parsed as ReadingRecord;
	if (typeof r.id !== "string" || typeof r.kind !== "string" || typeof r.status !== "string" || !r.anchor || !r.snapshot) return null;
	return r;
}

function createReading(record: ReadingRecord): void {
	write(record);
	emit("readings-changed", record.anchor.chatId ? { chatId: record.anchor.chatId } : {});
}

function updateReading(
	id: string,
	patch: Partial<Omit<ReadingRecord, "id" | "kind" | "createdAt">>,
): ReadingRecord | null {
	const record = getReading(id);
	if (!record) return null;
	const next: ReadingRecord = { ...record, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
	write(next);
	emit("readings-changed", next.anchor.chatId ? { chatId: next.anchor.chatId } : {});
	return next;
}

function listReadings(): ReadingRecord[] {
	let files: string[];
	try {
		files = fs.readdirSync(readingsDir());
	} catch {
		return [];
	}
	return files
		.filter((f) => f.endsWith(".json"))
		.map((f) => getReading(f.slice(0, -5)))
		.filter((r): r is ReadingRecord => r !== null)
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function deleteReading(id: string): boolean {
	const record = getReading(id);
	try {
		fs.unlinkSync(readingFile(id));
	} catch {
		return false;
	}
	emit("readings-changed", record?.anchor.chatId ? { chatId: record.anchor.chatId } : {});
	return true;
}

export const readingStore: ReadingStore = {
	createReading,
	getReading,
	updateReading,
	listReadings,
	deleteReading,
};
