/**
 * /api/themes (theme wave, 2026-11-04) — the theme catalog.
 *
 *   GET  → 200 { themes: Theme[] }: the built-in presets, then the
 *          imported customs (config.THEMES_DIR) sorted by id.
 *   POST → body = a ThemeFile { name, mode, colors: {…12 hex} }. Oversized
 *          bodies (Content-Length or raw bytes > MAX_THEME_BODY_BYTES) are
 *          refused (413); invalid JSON/shape → 400 naming the first bad
 *          field, nothing written. Valid → the id is the name's slug
 *          (builtin ids reserved, collisions get -2, -3, …), the file lands
 *          at <id>.json → 201 { theme }.
 */

import { BUILTIN_THEMES, isBuiltinThemeId, MAX_THEME_BODY_BYTES, parseThemeFile, themeIdFromName } from "@/src/core";
import { themeStore } from "@/src/server";

export const dynamic = "force-dynamic";

/** Byte length of a UTF-8 string (no Node Buffer dependency). */
function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

export async function GET() {
	return Response.json({ themes: [...BUILTIN_THEMES, ...themeStore.listThemes()] });
}

export async function POST(request: Request) {
	// Cap BEFORE reading the whole body into memory when the client declares
	// a length; then cap the raw bytes too (chunked / lying Content-Length).
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > MAX_THEME_BODY_BYTES) {
		return Response.json({ error: "theme file too large" }, { status: 413 });
	}
	const raw = await request.text().catch(() => null);
	if (raw === null) return Response.json({ error: "body must be JSON" }, { status: 400 });
	if (byteLength(raw) > MAX_THEME_BODY_BYTES) {
		return Response.json({ error: "theme file too large" }, { status: 413 });
	}
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	const parsed = parseThemeFile(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const base = themeIdFromName(parsed.theme.name);
	const taken = (id: string) => isBuiltinThemeId(id) || themeStore.readTheme(id) !== null;
	let id = base;
	for (let n = 2; taken(id); n++) id = `${base}-${n}`;
	themeStore.writeTheme(id, parsed.theme);
	return Response.json({ theme: { ...parsed.theme, id, builtin: false } }, { status: 201 });
}
