import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SESSION_TAGS_CHANGED_EVENT,
	SESSION_TAGS_KEY,
	addSessionTag,
	allSessionTags,
	deleteSessionTags,
	loadSessionTags,
	normalizeTag,
	parseSessionTags,
	pruneSessionTags,
	removeSessionTag,
	saveSessionTags,
} from "../components/session-tags.ts";

describe("session-tags constants & normalizeTag", () => {
	it("uses expected storage key and change event names", () => {
		assert.equal(SESSION_TAGS_KEY, "lh:session-tags");
		assert.equal(SESSION_TAGS_CHANGED_EVENT, "lh:session-tags-changed");
	});

	it("trims ends and collapses internal whitespace while preserving case", () => {
		assert.equal(normalizeTag("  Multivariable   Calculus \t\n "), "Multivariable Calculus");
		assert.equal(normalizeTag("Python"), "Python");
		assert.equal(normalizeTag("  FEEX "), "FEEX");
		assert.equal(normalizeTag("   \n\t "), "");
	});
});

describe("parseSessionTags", () => {
	it("returns {} for null, empty, corrupt, or non-object JSON", () => {
		assert.deepEqual(parseSessionTags(null), {});
		assert.deepEqual(parseSessionTags(""), {});
		assert.deepEqual(parseSessionTags("{not-json"), {});
		assert.deepEqual(parseSessionTags('["Python"]'), {});
		assert.deepEqual(parseSessionTags("42"), {});
		assert.deepEqual(parseSessionTags("null"), {});
	});

	it("sanitizes entries, normalizes tags, dedupes case-insensitively, and drops empties/unsafe keys", () => {
		const raw = JSON.stringify({
			c1: ["  Python  ", "python", 123, "   ", "Multivariable   Calculus"],
			c2: ["   ", null],
			c3: "not-an-array",
			constructor: ["Bad"],
		});
		assert.deepEqual(parseSessionTags(raw), {
			c1: ["Python", "Multivariable Calculus"],
		});
	});
});

describe("pure map mutations: add / remove / delete / prune", () => {
	it("addSessionTag normalizes, appends, and avoids case-insensitive duplicates", () => {
		let map = addSessionTag({}, "c1", "  Multivariable   Calculus ");
		assert.deepEqual(map, { c1: ["Multivariable Calculus"] });

		const dup = addSessionTag(map, "c1", "multivariable calculus");
		assert.equal(dup, map, "case-insensitive duplicate is a no-op");

		const empty = addSessionTag(map, "c1", "   ");
		assert.equal(empty, map, "blank tag is a no-op");

		map = addSessionTag(map, "c1", "FEEX");
		map = addSessionTag(map, "c2", "Python");
		assert.deepEqual(map, {
			c1: ["Multivariable Calculus", "FEEX"],
			c2: ["Python"],
		});
	});

	it("removeSessionTag removes case-insensitively and deletes key when empty", () => {
		const start = { c1: ["Python", "FEEX"], c2: ["Calculus"] };
		const afterOne = removeSessionTag(start, "c1", "python");
		assert.deepEqual(afterOne, { c1: ["FEEX"], c2: ["Calculus"] });

		const afterLast = removeSessionTag(afterOne, "c1", "feex");
		assert.deepEqual(afterLast, { c2: ["Calculus"] });
		assert.equal(Object.hasOwn(afterLast, "c1"), false);

		const noop = removeSessionTag(afterLast, "c2", "Missing");
		assert.equal(noop, afterLast);
	});

	it("deleteSessionTags drops all tags for a deleted session", () => {
		const start = { c1: ["Python"], c2: ["FEEX"] };
		assert.deepEqual(deleteSessionTags(start, "c1"), { c2: ["FEEX"] });
		assert.equal(deleteSessionTags(start, "missing"), start);
	});

	it("pruneSessionTags keeps only tags for existing chat IDs (Set or Array)", () => {
		const start = { c1: ["Python"], c2: ["FEEX"], c3: ["Calculus"] };
		assert.deepEqual(pruneSessionTags(start, new Set(["c1", "c3"])), {
			c1: ["Python"],
			c3: ["Calculus"],
		});
		assert.deepEqual(pruneSessionTags(start, ["c2"]), { c2: ["FEEX"] });
		assert.equal(pruneSessionTags(start, ["c1", "c2", "c3"]), start);
	});
});

describe("allSessionTags", () => {
	it("counts unique tags across visibleChats and sorts by count desc then alphabetically", () => {
		const map = {
			c1: ["Python", "FEEX"],
			c2: ["python", "Multivariable Calculus"],
			c3: ["Algorithms"],
			deleted: ["Hidden Subject", "Python"],
		};
		const visible = [{ id: "c1" }, { id: "c2" }, { id: "c3" }, { id: "c1" }];
		assert.deepEqual(allSessionTags(map, visible), [
			{ tag: "Python", count: 2 },
			{ tag: "Algorithms", count: 1 },
			{ tag: "FEEX", count: 1 },
			{ tag: "Multivariable Calculus", count: 1 },
		]);
		assert.deepEqual(allSessionTags(map, []), []);
		assert.deepEqual(allSessionTags(map, null), []);
	});
});

describe("loadSessionTags & saveSessionTags guards", () => {
	it("is SSR-safe when window is undefined", () => {
		assert.equal(typeof window, "undefined");
		assert.deepEqual(loadSessionTags(), {});
		assert.doesNotThrow(() => saveSessionTags({ c1: ["Python"] }));
	});

	it("loads, saves, removes empty maps, dispatches change events, and survives blocked storage", () => {
		const store = new Map<string, string>();
		const events: string[] = [];
		const fakeWindow = {
			localStorage: {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => store.set(k, v),
				removeItem: (k: string) => store.delete(k),
			},
			CustomEvent: class {
				type: string;
				constructor(type: string) {
					this.type = type;
				}
			},
			dispatchEvent: (ev: { type: string }) => {
				events.push(ev.type);
				return true;
			},
		};
		const prev = Object.getOwnPropertyDescriptor(globalThis, "window");
		Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: fakeWindow });
		try {
			saveSessionTags({ c1: ["Python", "  FEEX  "], c2: [] });
			assert.deepEqual(loadSessionTags(), { c1: ["Python", "FEEX"] });
			assert.deepEqual(events, [SESSION_TAGS_CHANGED_EVENT]);

			saveSessionTags({});
			assert.equal(store.has(SESSION_TAGS_KEY), false);
			assert.deepEqual(loadSessionTags(), {});

			// Blocked localStorage (throws on get/set/remove)
			fakeWindow.localStorage.getItem = () => {
				throw new Error("SecurityError");
			};
			fakeWindow.localStorage.setItem = () => {
				throw new Error("QuotaExceededError");
			};
			fakeWindow.localStorage.removeItem = () => {
				throw new Error("SecurityError");
			};
			assert.deepEqual(loadSessionTags(), {});
			assert.doesNotThrow(() => saveSessionTags({ c1: ["Python"] }));
		} finally {
			if (prev) Object.defineProperty(globalThis, "window", prev);
			else Reflect.deleteProperty(globalThis, "window");
		}
	});
});
