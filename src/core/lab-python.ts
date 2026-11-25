/**
 * Pure Python source helpers for Twig Lab v2: deterministic cell source hashing
 * and top-level symbol / import generation for extracting cells to `.py` files.
 * Browser-safe (zero node:* imports).
 */

const PYTHON_KEYWORDS = new Set([
	"False", "None", "True", "and", "as", "assert", "async", "await",
	"break", "class", "continue", "def", "del", "elif", "else", "except",
	"finally", "for", "from", "global", "if", "import", "in", "is",
	"lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try",
	"while", "with", "yield",
]);

/**
 * Deterministic 64-bit FNV-1a fingerprint encoded as 16 lowercase hex chars.
 * Identical in browser and Node so edited vs executed cell states stay consistent.
 */
export function hashCellSource(source: string): string {
	let h1 = 0x811c9dc5;
	let h2 = 0x9e3779b9;
	for (let i = 0; i < source.length; i++) {
		const c = source.charCodeAt(i);
		h1 = Math.imul(h1 ^ c, 0x01000193);
		h2 = Math.imul(h2 ^ (c + i), 0x01000193);
	}
	return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Extract top-level `def`, `async def`, and `class` symbol names from Python source.
 * Prefers public names (not starting with `_`), falling back to all found symbols
 * if only underscore-prefixed definitions exist.
 */
export function extractTopLevelPythonSymbols(source: string): string[] {
	const all: string[] = [];
	const seen = new Set<string>();
	for (const line of source.split(/\r?\n/)) {
		const m = /^(?:async\s+def|def|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b/.exec(line);
		if (!m) continue;
		const sym = m[1]!;
		if (!seen.has(sym)) {
			seen.add(sym);
			all.push(sym);
		}
	}
	const pub = all.filter((s) => !s.startsWith("_"));
	return pub.length > 0 ? pub : all;
}

function toSnakeCase(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[^A-Za-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "")
		.toLowerCase();
}

export function suggestModuleFilename(source: string, fallbackStem = "helpers"): string {
	const symbols = extractTopLevelPythonSymbols(source);
	const raw = symbols[0] ? toSnakeCase(symbols[0]) : toSnakeCase(fallbackStem);
	const stem = raw && !/^[0-9]/.test(raw) && !PYTHON_KEYWORDS.has(raw) ? raw : "helpers";
	return `${stem}.py`;
}

export function modulePathToImportName(relPath: string): string | null {
	const normalized = relPath.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
	if (!normalized.endsWith(".py")) return null;
	const withoutExt = normalized.slice(0, -3);
	const parts = withoutExt.split("/");
	if (parts.length === 0) return null;
	if (parts.at(-1) === "__init__") parts.pop();
	if (parts.length === 0) return null;
	for (const seg of parts) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) || PYTHON_KEYWORDS.has(seg)) {
			return null;
		}
	}
	return parts.join(".");
}

export function buildImportStatement(relPath: string, symbols: readonly string[]): string {
	const modName = modulePathToImportName(relPath);
	if (!modName) {
		return `# Saved to ${relPath}`;
	}
	const cleanSymbols = symbols.filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
	if (cleanSymbols.length > 0) {
		return `from ${modName} import ${cleanSymbols.join(", ")}`;
	}
	return `import ${modName}`;
}
