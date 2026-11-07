/**
 * The Anki card store (core/ports.ts AnkiStore): config.ANKI_CARDS_FILE, a
 * JSON map nodeId → AnkiNoteRecord. Read-modify-write with an atomic
 * replace, like sources.json. Invalid entries are skipped on read (the
 * JSONL readers' tolerance), so a hand-edited file degrades, never throws.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ANKI_CARDS_FILE } from "../../config.ts";
import { ANKI_CARD_FORMATS, ANKI_CARD_KINDS, type AnkiCard, type AnkiNoteRecord } from "../core/anki.ts";
import type { AnkiStore } from "../core/ports.ts";
import { writeFileAtomicSync } from "./atomic-write.ts";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";

function isCard(v: unknown): v is AnkiCard {
	return isRecord(v) && (ANKI_CARD_KINDS as readonly unknown[]).includes(v.kind) && isString(v.front) && isString(v.back) &&
		(v.format === undefined || (ANKI_CARD_FORMATS as readonly unknown[]).includes(v.format)) &&
		(v.extra === undefined || isString(v.extra));
}

function isNoteRecord(v: unknown): v is AnkiNoteRecord {
	return isRecord(v) && isString(v.nodeId) && isString(v.sourceId) && isString(v.deck) && isString(v.createdAt) &&
		Array.isArray(v.cards) && v.cards.every(isCard) &&
		(v.deliveredAt === undefined || isString(v.deliveredAt)) &&
		(v.noteIds === undefined || (Array.isArray(v.noteIds) && v.noteIds.every((n) => typeof n === "number")));
}

function readMap(file: string): Map<string, AnkiNoteRecord> {
	const out = new Map<string, AnkiNoteRecord>();
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!isRecord(parsed)) return out;
		for (const [id, value] of Object.entries(parsed)) if (isNoteRecord(value) && value.nodeId === id) out.set(id, value);
	} catch {
		// absent or corrupt — nothing carded yet
	}
	return out;
}

/** A store over one file — exported for tests (a temp path); the app uses
 *  the default instance below. */
export function createAnkiStore(file: string = ANKI_CARDS_FILE): AnkiStore {
	return {
		readRecords: () => readMap(file),
		upsertRecords(records) {
			if (records.length === 0) return;
			const all = readMap(file);
			for (const record of records) all.set(record.nodeId, record);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			writeFileAtomicSync(file, JSON.stringify(Object.fromEntries(all), null, "\t"));
		},
		deleteRecords(nodeIds) {
			const all = readMap(file);
			let removed = 0;
			for (const id of nodeIds) if (all.delete(id)) removed++;
			if (removed > 0) writeFileAtomicSync(file, JSON.stringify(Object.fromEntries(all), null, "\t"));
			return removed;
		},
	};
}

export const ankiStore = createAnkiStore();
