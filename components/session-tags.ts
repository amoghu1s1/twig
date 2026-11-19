/**
 * Subject / course tags for sessions — client-persisted in localStorage (`lh:session-tags`)
 * and synced across surfaces via `lh:session-tags-changed`.
 *
 * Pure data helpers + SSR- and storage-guarded load/save so both unit tests and
 * React components can import directly without touching IO or server layers.
 */

export const SESSION_TAGS_KEY = "lh:session-tags";
export const SESSION_TAGS_CHANGED_EVENT = "lh:session-tags-changed";

export type SessionTagsMap = Record<string, string[]>;

export interface SessionTagCount {
	tag: string;
	count: number;
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Normalize a raw subject/course tag: trim ends and collapse internal whitespace. */
export function normalizeTag(raw: string): string {
	return raw.trim().replace(/\s+/g, " ");
}

function dedupeTags(rawList: readonly unknown[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const entry of rawList) {
		if (typeof entry !== "string") continue;
		const norm = normalizeTag(entry);
		if (!norm) continue;
		const key = norm.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(norm);
	}
	return out;
}

/** Parse and sanitize persisted `chatId -> string[]` tag JSON. Never throws. */
export function parseSessionTags(raw: string | null): SessionTagsMap {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: SessionTagsMap = {};
		for (const [chatId, list] of Object.entries(parsed as Record<string, unknown>)) {
			if (!chatId || UNSAFE_KEYS.has(chatId) || !Array.isArray(list)) continue;
			const tags = dedupeTags(list);
			if (tags.length > 0) out[chatId] = tags;
		}
		return out;
	} catch {
		return {};
	}
}

/** Add a normalized tag to `chatId` (case-insensitive unique per session). */
export function addSessionTag(map: SessionTagsMap, chatId: string, tag: string): SessionTagsMap {
	const id = chatId.trim();
	const norm = normalizeTag(tag);
	if (!id || UNSAFE_KEYS.has(id) || !norm) return map;
	const existing = map[id] ?? [];
	const lower = norm.toLowerCase();
	if (existing.some((t) => t.toLowerCase() === lower)) return map;
	return { ...map, [id]: [...existing, norm] };
}

/** Remove a tag from `chatId` (case-insensitive), dropping empty entries. */
export function removeSessionTag(map: SessionTagsMap, chatId: string, tag: string): SessionTagsMap {
	const existing = map[chatId];
	const norm = normalizeTag(tag);
	if (!existing || !norm) return map;
	const lower = norm.toLowerCase();
	const nextTags = existing.filter((t) => t.toLowerCase() !== lower);
	if (nextTags.length === existing.length) return map;
	if (nextTags.length === 0) {
		const rest = { ...map };
		delete rest[chatId];
		return rest;
	}
	return { ...map, [chatId]: nextTags };
}

/** Remove all tags belonging to a deleted session. */
export function deleteSessionTags(map: SessionTagsMap, chatId: string): SessionTagsMap {
	if (!Object.hasOwn(map, chatId)) return map;
	const rest = { ...map };
	delete rest[chatId];
	return rest;
}

/** Retain tags only for sessions present in `existingChatIds`. */
export function pruneSessionTags(map: SessionTagsMap, existingChatIds: Iterable<string>): SessionTagsMap {
	const live = existingChatIds instanceof Set ? existingChatIds : new Set(existingChatIds);
	let changed = false;
	const next: SessionTagsMap = {};
	for (const [chatId, list] of Object.entries(map)) {
		if (!live.has(chatId) || UNSAFE_KEYS.has(chatId) || !Array.isArray(list)) {
			changed = true;
			continue;
		}
		const clean = dedupeTags(list);
		if (clean.length === 0) {
			changed = true;
			continue;
		}
		if (clean.length !== list.length) changed = true;
		next[chatId] = clean;
	}
	return changed ? next : map;
}

/** Collect unique tags across `visibleChats`, sorted by count descending then alphabetically. */
export function allSessionTags(
	map: SessionTagsMap,
	visibleChats: readonly { id: string }[] | null | undefined,
): SessionTagCount[] {
	if (!visibleChats || visibleChats.length === 0) return [];
	const seenChats = new Set<string>();
	const counts = new Map<string, SessionTagCount>();
	for (const chat of visibleChats) {
		if (!chat?.id || seenChats.has(chat.id)) continue;
		seenChats.add(chat.id);
		const tags = map[chat.id];
		if (!Array.isArray(tags)) continue;
		const seenForChat = new Set<string>();
		for (const raw of tags) {
			const norm = normalizeTag(raw);
			if (!norm) continue;
			const key = norm.toLowerCase();
			if (seenForChat.has(key)) continue;
			seenForChat.add(key);
			const entry = counts.get(key);
			if (entry) entry.count += 1;
			else counts.set(key, { tag: norm, count: 1 });
		}
	}
	return [...counts.values()].sort(
		(a, b) => b.count - a.count || a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }),
	);
}

/** Read persisted session tags safely (SSR and blocked storage return `{}`). */
export function loadSessionTags(): SessionTagsMap {
	if (typeof window === "undefined") return {};
	try {
		return parseSessionTags(window.localStorage.getItem(SESSION_TAGS_KEY));
	} catch {
		return {};
	}
}

/** Persist session tags safely and notify listeners (`lh:session-tags-changed`). */
export function saveSessionTags(map: SessionTagsMap): void {
	if (typeof window === "undefined") return;
	const clean: SessionTagsMap = {};
	for (const [chatId, list] of Object.entries(map)) {
		if (!chatId || UNSAFE_KEYS.has(chatId) || !Array.isArray(list)) continue;
		const tags = dedupeTags(list);
		if (tags.length > 0) clean[chatId] = tags;
	}
	try {
		if (Object.keys(clean).length > 0) {
			window.localStorage.setItem(SESSION_TAGS_KEY, JSON.stringify(clean));
		} else {
			window.localStorage.removeItem(SESSION_TAGS_KEY);
		}
	} catch {
		// Blocked storage: keep working in-memory for the active surface.
	}
	try {
		if (typeof window.CustomEvent === "function") {
			window.dispatchEvent?.(new window.CustomEvent(SESSION_TAGS_CHANGED_EVENT));
		} else if (typeof window.Event === "function") {
			window.dispatchEvent?.(new window.Event(SESSION_TAGS_CHANGED_EVENT));
		}
	} catch {
		// Ignore synthetic window stubs without dispatchEvent/Event constructors.
	}
}
