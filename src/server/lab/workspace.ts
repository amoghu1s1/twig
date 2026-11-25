import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createEmptyLabNotebook,
	parseIpynb,
	serializeIpynb,
	slugifyLabFolderName,
} from "../../core/lab-ipynb.ts";
import { normalizeLabNudgeLevel } from "../../core/lab-nudge.ts";
import type {
	LabLanguage,
	LabNotebook,
	LabNudgeLevel,
	LabSessionMeta,
	LabWorkspaceFile,
} from "../../core/contracts/lab.ts";
import { writeFileAtomicSync } from "../../store/atomic-write.ts";
import { readSettings } from "../../store/settings.ts";
import { resolveDefaultPython } from "./python-envs.ts";

const IGNORED_DIRS = new Set([
	".git",
	".venv",
	"venv",
	"env",
	"__pycache__",
	"node_modules",
	".ipynb_checkpoints",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
]);

const MAX_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LISTED_FILES = 300;
const EDITABLE_EXTS = new Set([
	".py", ".pyi", ".txt", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml",
	".toml", ".ini", ".cfg", ".env", ".sh", ".sql", ".js", ".ts", ".jsx", ".tsx",
	".css", ".html", ".xml", ".ipynb",
]);

export function expandHomePath(input: string): string {
	const trimmed = input.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.join(os.homedir(), trimmed.slice(2));
	}
	return path.resolve(trimmed);
}

export function defaultLabsRootDir(): string {
	const configured = readSettings()?.lab?.defaultRootDir?.trim();
	if (configured) return expandHomePath(configured);
	return path.join(os.homedir(), "Documents", "Twig Labs");
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf-8").digest("hex");
}

function resolveCanonicalDir(dirPath: string): string {
	const resolved = expandHomePath(dirPath);
	let real: string;
	try {
		real = fs.realpathSync.native(resolved);
	} catch {
		throw new Error(`Directory does not exist: ${dirPath}`);
	}
	const stat = fs.statSync(real);
	if (!stat.isDirectory()) {
		throw new Error(`Path is not a directory: ${dirPath}`);
	}
	return real;
}

function pickUniqueSubdir(rootDir: string, slug: string): string {
	const first = path.join(rootDir, slug);
	if (!fs.existsSync(first)) return first;
	for (let i = 2; i < 10_000; i++) {
		const candidate = path.join(rootDir, `${slug}-${i}`);
		if (!fs.existsSync(candidate)) return candidate;
	}
	return path.join(rootDir, `${slug}-${Date.now().toString(36)}`);
}

export async function provisionLabWorkspace(opts: {
	title: string;
	workspaceDir?: string;
	interpreterPath?: string;
	language?: LabLanguage;
	nudgeLevel?: LabNudgeLevel;
}): Promise<{ meta: LabSessionMeta; notebook: LabNotebook }> {
	const language: LabLanguage = opts.language ?? "python";
	const notebookFile = "notebook.ipynb";
	let realDir: string;
	let notebook: LabNotebook;

	if (opts.workspaceDir && opts.workspaceDir.trim()) {
		realDir = resolveCanonicalDir(opts.workspaceDir);
		const nbPath = path.join(realDir, notebookFile);
		if (fs.existsSync(nbPath)) {
			notebook = parseIpynb(fs.readFileSync(nbPath, "utf-8"));
		} else {
			notebook = createEmptyLabNotebook(opts.title, language);
			writeFileAtomicSync(nbPath, serializeIpynb(notebook), { allowInPlaceFallback: true });
		}
	} else {
		const rootDir = defaultLabsRootDir();
		fs.mkdirSync(rootDir, { recursive: true });
		const realRoot = fs.realpathSync.native(rootDir);
		const slug = slugifyLabFolderName(opts.title);
		const target = pickUniqueSubdir(realRoot, slug);
		fs.mkdirSync(target, { recursive: true });
		realDir = fs.realpathSync.native(target);
		notebook = createEmptyLabNotebook(opts.title, language);
		writeFileAtomicSync(path.join(realDir, notebookFile), serializeIpynb(notebook), { allowInPlaceFallback: true });
	}

	const labSettings = readSettings()?.lab;
	const resolvedInterpreter = await resolveDefaultPython({
		workspaceDir: realDir,
		configuredPythonPath: labSettings?.pythonPath,
		explicitInterpreterPath: opts.interpreterPath,
	});
	const nudgeLevel = normalizeLabNudgeLevel(opts.nudgeLevel ?? labSettings?.defaultNudgeLevel);

	return {
		meta: {
			workspaceDir: realDir,
			notebookFile,
			language,
			nudgeLevel,
			...(resolvedInterpreter ? { interpreterPath: resolvedInterpreter } : {}),
		},
		notebook,
	};
}

function safeNotebookPath(meta: LabSessionMeta): string {
	const realRoot = resolveCanonicalDir(meta.workspaceDir);
	const cleanFile = path.basename(meta.notebookFile || "notebook.ipynb");
	if (!cleanFile || cleanFile === "." || cleanFile === "..") {
		throw new Error("Invalid notebook filename.");
	}
	const target = path.join(realRoot, cleanFile);
	if (fs.existsSync(target)) {
		const realTarget = fs.realpathSync.native(target);
		if (!realTarget.startsWith(realRoot + path.sep)) {
			throw new Error("Notebook path escapes workspace directory.");
		}
		return realTarget;
	}
	return target;
}

export function readLabNotebook(meta: LabSessionMeta): { notebook: LabNotebook; revision: string } {
	const nbPath = safeNotebookPath(meta);
	const raw = fs.readFileSync(nbPath, "utf-8");
	return {
		notebook: parseIpynb(raw),
		revision: sha256Hex(raw),
	};
}

export type WriteLabNotebookResult =
	| { ok: true; notebook: LabNotebook; revision: string }
	| { ok: false; conflict: true; notebook: LabNotebook; revision: string };

export function writeLabNotebook(
	meta: LabSessionMeta,
	notebook: LabNotebook,
	expectedRevision?: string,
): WriteLabNotebookResult {
	const nbPath = safeNotebookPath(meta);
	if (expectedRevision !== undefined && fs.existsSync(nbPath)) {
		const currentRaw = fs.readFileSync(nbPath, "utf-8");
		const currentRev = sha256Hex(currentRaw);
		if (currentRev !== expectedRevision) {
			return {
				ok: false,
				conflict: true,
				notebook: parseIpynb(currentRaw),
				revision: currentRev,
			};
		}
	}
	const serialized = serializeIpynb(notebook);
	writeFileAtomicSync(nbPath, serialized, { allowInPlaceFallback: true });
	return {
		ok: true,
		notebook,
		revision: sha256Hex(serialized),
	};
}

function validateRelativeWorkspacePath(relPath: string): string[] {
	const trimmed = relPath.trim();
	if (!trimmed || trimmed.includes("\0")) throw new Error("Invalid workspace file path.");
	if (path.isAbsolute(trimmed) || trimmed.startsWith("~")) {
		throw new Error("Workspace file path must be relative to the Lab folder.");
	}
	const normalized = trimmed.replace(/\\/g, "/");
	const segments = normalized.split("/").filter(Boolean);
	if (segments.length === 0) throw new Error("Empty workspace file path.");
	for (const seg of segments) {
		if (seg === "." || seg === "..") {
			throw new Error(`Path traversal is not allowed: ${relPath}`);
		}
	}
	return segments;
}

function confineExistingWorkspacePath(workspaceDir: string, relPath: string): string {
	const realRoot = resolveCanonicalDir(workspaceDir);
	const segments = validateRelativeWorkspacePath(relPath);
	const candidate = path.join(realRoot, ...segments);
	let realTarget: string;
	try {
		realTarget = fs.realpathSync.native(candidate);
	} catch {
		throw new Error(`File not found in workspace: ${relPath}`);
	}
	if (!realTarget.startsWith(realRoot + path.sep)) {
		throw new Error(`Path escapes workspace directory: ${relPath}`);
	}
	return realTarget;
}

function confineWritableWorkspacePath(workspaceDir: string, relPath: string): string {
	const realRoot = resolveCanonicalDir(workspaceDir);
	const segments = validateRelativeWorkspacePath(relPath);
	let cursor = realRoot;
	for (let i = 0; i < segments.length - 1; i++) {
		cursor = path.join(cursor, segments[i]!);
		const lstat = fs.lstatSync(cursor, { throwIfNoEntry: false });
		if (lstat) {
			if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
				throw new Error(`Parent path cannot be traversed: ${relPath}`);
			}
		} else {
			fs.mkdirSync(cursor);
		}
		const realCursor = fs.realpathSync.native(cursor);
		if (!realCursor.startsWith(realRoot + path.sep)) {
			throw new Error(`Path escapes workspace directory: ${relPath}`);
		}
	}
	const target = path.join(cursor, segments[segments.length - 1]!);
	const existing = fs.lstatSync(target, { throwIfNoEntry: false });
	if (existing) {
		if (existing.isSymbolicLink()) {
			const realTarget = fs.realpathSync.native(target);
			if (!realTarget.startsWith(realRoot + path.sep)) {
				throw new Error(`Path escapes workspace directory: ${relPath}`);
			}
		} else if (existing.isDirectory()) {
			throw new Error(`Target is a directory: ${relPath}`);
		}
	}
	return target;
}

function isEditableName(fileName: string): boolean {
	const ext = path.extname(fileName).toLowerCase();
	if (EDITABLE_EXTS.has(ext)) return true;
	return fileName === "Makefile" || fileName === "Dockerfile" || fileName === ".gitignore";
}

export function listWorkspaceFiles(workspaceDir: string): LabWorkspaceFile[] {
	const realRoot = resolveCanonicalDir(workspaceDir);
	const items: LabWorkspaceFile[] = [];

	const walk = (dir: string, relPrefix: string) => {
		if (items.length >= MAX_LISTED_FILES) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => {
			if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
		for (const entry of entries) {
			if (items.length >= MAX_LISTED_FILES) break;
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (IGNORED_DIRS.has(entry.name)) continue;
				const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
				items.push({ path: rel, name: entry.name, kind: "dir" });
				walk(path.join(dir, entry.name), rel);
			} else if (entry.isFile()) {
				const full = path.join(dir, entry.name);
				let sizeBytes = 0;
				try {
					sizeBytes = fs.statSync(full).size;
				} catch {
					continue;
				}
				const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
				items.push({
					path: rel,
					name: entry.name,
					kind: "file",
					sizeBytes,
					editable: isEditableName(entry.name) && sizeBytes <= MAX_WORKSPACE_FILE_BYTES,
				});
			}
		}
	};

	walk(realRoot, "");
	return items;
}

export function readWorkspaceFile(workspaceDir: string, relPath: string): { path: string; content: string; sizeBytes: number } {
	const realFile = confineExistingWorkspacePath(workspaceDir, relPath);
	const stat = fs.statSync(realFile);
	if (!stat.isFile()) throw new Error(`Not a file: ${relPath}`);
	if (stat.size > MAX_WORKSPACE_FILE_BYTES) {
		throw new Error(`File exceeds 2 MiB limit (${stat.size} bytes): ${relPath}`);
	}
	const buf = fs.readFileSync(realFile);
	if (buf.subarray(0, 8192).includes(0)) {
		throw new Error(`Binary files cannot be opened as text: ${relPath}`);
	}
	return {
		path: validateRelativeWorkspacePath(relPath).join("/"),
		content: buf.toString("utf-8"),
		sizeBytes: stat.size,
	};
}

export function writeWorkspaceFile(workspaceDir: string, relPath: string, content: string): { path: string; sizeBytes: number } {
	if (Buffer.byteLength(content, "utf-8") > MAX_WORKSPACE_FILE_BYTES) {
		throw new Error("File content exceeds 2 MiB limit.");
	}
	const target = confineWritableWorkspacePath(workspaceDir, relPath);
	writeFileAtomicSync(target, content, { allowInPlaceFallback: true });
	const stat = fs.statSync(target);
	return {
		path: validateRelativeWorkspacePath(relPath).join("/"),
		sizeBytes: stat.size,
	};
}

export function deleteWorkspaceFile(workspaceDir: string, relPath: string): boolean {
	const cleanSegments = validateRelativeWorkspacePath(relPath);
	if (cleanSegments.length === 1 && cleanSegments[0] === "notebook.ipynb") {
		throw new Error("Cannot delete the primary notebook.ipynb file.");
	}
	const realFile = confineExistingWorkspacePath(workspaceDir, relPath);
	fs.unlinkSync(realFile);
	return true;
}

export function createWorkspaceFolder(workspaceDir: string, relPath: string): { path: string } {
	const realRoot = resolveCanonicalDir(workspaceDir);
	const segments = validateRelativeWorkspacePath(relPath);
	let cursor = realRoot;
	for (const seg of segments) {
		cursor = path.join(cursor, seg);
		const lstat = fs.lstatSync(cursor, { throwIfNoEntry: false });
		if (lstat) {
			if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
				throw new Error(`Cannot create folder inside existing non-directory path: ${relPath}`);
			}
		} else {
			fs.mkdirSync(cursor);
		}
		const realCursor = fs.realpathSync.native(cursor);
		if (!realCursor.startsWith(realRoot + path.sep)) {
			throw new Error(`Path escapes workspace directory: ${relPath}`);
		}
	}
	return { path: segments.join("/") };
}

export function renameWorkspaceFile(
	workspaceDir: string,
	fromRelPath: string,
	toRelPath: string,
): { fromPath: string; path: string } {
	const fromSegments = validateRelativeWorkspacePath(fromRelPath);
	const toSegments = validateRelativeWorkspacePath(toRelPath);
	if (fromSegments.length === 1 && fromSegments[0] === "notebook.ipynb") {
		throw new Error("Cannot rename the primary notebook.ipynb file.");
	}
	if (toSegments.length === 1 && toSegments[0] === "notebook.ipynb") {
		throw new Error("Cannot overwrite the primary notebook.ipynb file.");
	}
	const realFrom = confineExistingWorkspacePath(workspaceDir, fromRelPath);
	const target = confineWritableWorkspacePath(workspaceDir, toRelPath);
	if (fs.lstatSync(target, { throwIfNoEntry: false })) {
		throw new Error(`Destination already exists: ${toRelPath}`);
	}
	fs.renameSync(realFrom, target);
	return {
		fromPath: fromSegments.join("/"),
		path: toSegments.join("/"),
	};
}
