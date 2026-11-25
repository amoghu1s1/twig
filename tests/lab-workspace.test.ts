import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

// Set isolated LH_DATA_DIR before importing config/store modules.
const TMP_ROOT = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "lh-lab-ws-")));
process.env.LH_DATA_DIR = path.join(TMP_ROOT, "data");

const { settingsStore } = await import("../src/store/settings.ts");
const {
	createWorkspaceFolder,
	deleteWorkspaceFile,
	listWorkspaceFiles,
	provisionLabWorkspace,
	readLabNotebook,
	readWorkspaceFile,
	renameWorkspaceFile,
	writeLabNotebook,
	writeWorkspaceFile,
} = await import("../src/server/lab/workspace.ts");
const { createEmptyLabNotebook } = await import("../src/core/index.ts");

after(() => {
	fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("lab workspace", () => {
	it("auto-provisions unique folders under configured defaultRootDir and handles collisions", async () => {
		const labsHome = path.join(TMP_ROOT, "Twig Labs");
		settingsStore.writeSettings({ version: 1, lab: { defaultRootDir: labsHome } });

		const first = await provisionLabWorkspace({ title: "Tensor Practice" });
		assert.equal(path.dirname(first.meta.workspaceDir), labsHome);
		assert.equal(path.basename(first.meta.workspaceDir), "tensor-practice");
		assert.equal(fs.existsSync(path.join(first.meta.workspaceDir, "notebook.ipynb")), true);

		const second = await provisionLabWorkspace({ title: "Tensor Practice" });
		assert.equal(path.basename(second.meta.workspaceDir), "tensor-practice-2");
	});

	it("binds an existing directory and preserves its existing notebook.ipynb without overwriting", async () => {
		const existingDir = path.join(TMP_ROOT, "existing-project");
		fs.mkdirSync(existingDir, { recursive: true });
		const nb = createEmptyLabNotebook("Preexisting");
		nb.cells[1]!.source = "print('preexisting')";
		const meta = { workspaceDir: existingDir, notebookFile: "notebook.ipynb", language: "python" as const };
		writeLabNotebook(meta, nb);

		const provisioned = await provisionLabWorkspace({ title: "Ignored Title", workspaceDir: existingDir });
		assert.equal(provisioned.meta.workspaceDir, existingDir);
		assert.equal(provisioned.notebook.cells[1]?.source, "print('preexisting')");
	});

	it("detects stale revisions on writeLabNotebook", () => {
		const dir = path.join(TMP_ROOT, "rev-test");
		fs.mkdirSync(dir, { recursive: true });
		const meta = { workspaceDir: dir, notebookFile: "notebook.ipynb", language: "python" as const };
		const nb = createEmptyLabNotebook("Rev Test");
		const w1 = writeLabNotebook(meta, nb);
		assert.equal(w1.ok, true);

		const nb2 = { ...nb, cells: [...nb.cells] };
		nb2.cells[1] = { ...nb2.cells[1]!, source: "x = 1" };
		const w2 = writeLabNotebook(meta, nb2, w1.revision);
		assert.equal(w2.ok, true);

		// Writing again with the stale revision w1.revision triggers conflict
		const wConflict = writeLabNotebook(meta, nb, w1.revision);
		assert.equal(wConflict.ok, false);
		if (!wConflict.ok) {
			assert.equal(wConflict.conflict, true);
			assert.equal(wConflict.notebook.cells[1]?.source, "x = 1");
		}
	});

	it("enforces path confinement and blocks traversal, symlinks outside root, and deleting notebook.ipynb", () => {
		const dir = path.join(TMP_ROOT, "confined");
		const outside = path.join(TMP_ROOT, "outside-secret.txt");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(outside, "secret", "utf-8");
		fs.writeFileSync(path.join(dir, "notebook.ipynb"), JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }), "utf-8");

		const created = writeWorkspaceFile(dir, "helpers/math_utils.py", "def sq(x):\n    return x * x\n");
		assert.equal(created.path, "helpers/math_utils.py");
		assert.equal(readWorkspaceFile(dir, "helpers/math_utils.py").content, "def sq(x):\n    return x * x\n");

		const files = listWorkspaceFiles(dir);
		assert.ok(files.some((f) => f.path === "helpers/math_utils.py" && f.editable));

		assert.throws(() => readWorkspaceFile(dir, "../outside-secret.txt"), /traversal|not allowed/i);
		assert.throws(() => writeWorkspaceFile(dir, "../escape.py", "bad"), /traversal|not allowed/i);
		assert.throws(() => readWorkspaceFile(dir, outside), /relative/i);

		fs.symlinkSync(outside, path.join(dir, "escape-link.txt"));
		assert.throws(() => readWorkspaceFile(dir, "escape-link.txt"), /escapes/i);

		assert.throws(() => deleteWorkspaceFile(dir, "notebook.ipynb"), /primary notebook\.ipynb/i);
		assert.equal(deleteWorkspaceFile(dir, "helpers/math_utils.py"), true);
		assert.equal(readLabNotebook({ workspaceDir: dir, notebookFile: "notebook.ipynb", language: "python" }).notebook.nbformat, 4);
	});

	it("creates nested folders, renames confined files safely, and inherits defaultNudgeLevel", async () => {
		const labsHome = path.join(TMP_ROOT, "Twig Labs Nudge");
		settingsStore.writeSettings({
			version: 1,
			lab: { defaultRootDir: labsHome, defaultNudgeLevel: "balanced" },
		});
		const provisioned = await provisionLabWorkspace({ title: "Nudge Seeded" });
		assert.equal(provisioned.meta.nudgeLevel, "balanced");

		const dir = provisioned.meta.workspaceDir;
		const folder = createWorkspaceFolder(dir, "sim/core");
		assert.equal(folder.path, "sim/core");
		writeWorkspaceFile(dir, "sim/core/old_mod.py", "X = 1\n");
		const renamed = renameWorkspaceFile(dir, "sim/core/old_mod.py", "sim/core/new_mod.py");
		assert.equal(renamed.path, "sim/core/new_mod.py");
		assert.equal(readWorkspaceFile(dir, "sim/core/new_mod.py").content, "X = 1\n");

		assert.throws(() => createWorkspaceFolder(dir, "../escape-dir"), /traversal|not allowed/i);
		assert.throws(() => renameWorkspaceFile(dir, "notebook.ipynb", "other.ipynb"), /primary notebook\.ipynb/i);
		assert.throws(() => renameWorkspaceFile(dir, "sim/core/new_mod.py", "notebook.ipynb"), /primary notebook\.ipynb/i);
	});
});
