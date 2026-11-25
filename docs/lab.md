# Twig Lab

Twig Lab (`kind: "lab"`) is an interactive, Jupyter-style coding studio paired with a guided programming mentor. You write and run code in a real local folder on disk while the mentor adds scaffolding, exercises, checks, and feedback beside your work.

## Starting a Lab

- Switch the Home composer pill to **Lab**, click **Lab** in the sidebar, open `/chat/new?mode=lab`, or run **New Lab session** in the Command Palette (`Ctrl/Cmd+K`).
- **Workspace folder:** By default, Twig creates `~/Documents/Twig Labs/<slug>/notebook.ipynb` (configurable under **Settings → General → Twig Lab**). You can also pick or enter any folder before starting, or change/rebind the folder later from the Lab toolbar.
- **Knowledge graph picks are optional:** Selecting propositions seeds the mentor with your learning context, never blocks creating a Lab.
- **Safety on delete:** Deleting a Lab session stops its kernel and deletes the Twig chat record only; your folder and `.ipynb` / Python files on disk remain untouched.

## Workspace & Notebook Controls

- **Split pane:** Left pane holds the notebook (`notebook.ipynb`), toolbar, Workspace Files drawer, and live Variable Inspector; right pane holds the Twig mentor conversation. Drag the center divider to resize.
- **Cells (CodeMirror 6):**
  - **Code cells:** Syntax-highlighted Python with `Shift+Enter` (run & advance), `Ctrl/Cmd+Enter` (run in place), `Tab` indent, and `Mod+/` comment toggling.
  - **Markdown cells:** Supports Markdown and LaTeX math; double-click or click **Edit** to edit source.
  - **Check cells (`role: "check"`):** Self-check assertion or `test_*()` suites evaluated independently per top-level check against your live kernel namespace, reporting per-case status (`cases[]`, `checkPassed`, `status`: `not_run` / `stale` / `passed` / `failed`), milestone progress in `LabMilestoneStrip`, and **Run checks** across the notebook.
  - **Stale cell tracking:** Tracks `sourceHashAtRun` and `lastExecutedAt` so edited code cells show a **Modified** badge and downstream Check cells automatically invalidate (`Stale · re-run check`) until re-run.
  - **Predict-before-Run cells (`role: "predict"`):** Locks execution until you commit a brief prediction (with a **Skip** escape hatch), helping surface mental-model mismatches before inspecting output.
- **Cell actions & coaching modes:**
  - **Nudge / Balanced / Direct selector** in the Lab toolbar (with a default configurable in **Settings → General → Twig Lab**) controls mentor scaffolding: `Nudge` gives diagnostic pointers first (`pointer_only` on first failure, escalating only after repeat failures or explicit request), `Balanced` gives targeted hints/one-line fixes, and `Direct` allows immediate full patches.
  - **Ask mentor** quick-ask presets (**Hint only**, **Check my work**, **Explain cell**, **Show fix**) and **Debug with mentor** draft targeted cell snippets (code + output/traceback) straight into the mentor composer.

## Python Kernel, Environments & Files

- **Persistent local worker:** Runs your chosen local Python executable (`src/server/lab/python_kernel.py`) over authenticated loopback TCP, preserving imports, variables, and state across cell runs.
- **Auto-reload of workspace `.py` modules:** When you run a cell after editing a workspace `.py` file, modified workspace modules reload automatically before cell execution while keeping existing live kernel variables and updating `from mod import Sym` bindings.
- **Interpreter picker:** Switch between discovered virtualenvs (`venv`, `.venv`, conda, pyenv, `uv`, system Python) or enter a custom executable path from the Lab toolbar (or set a default in **Settings → General**).
- **Streaming & rich outputs:** Live stdout/stderr (with ANSI color support), automatic `matplotlib` plot PNG capture (with click-to-zoom lightbox and download), DataFrame HTML tables (sanitized), and clean tracebacks.
- **Interrupt & Restart:** Interrupt long loops without losing variables, or restart for a clean namespace.
- **Live Variable Inspector:** Compact footer strip and expandable table showing live variable names, types, tensor/array shapes, dtypes/devices, and value summaries.
- **Multi-file Workspace Files & Extraction:** Browse, create files or folders (`+ Folder`), inline rename, edit with `Ctrl/Cmd+S`, insert `from ... import ...` lines (`Insert import`), or click **Extract .py** on any code cell to move selected top-level functions/classes into a workspace module and replace the cell body with an import.

## Mentor Ownership & Knowledge Graph Bridge

The mentor interacts with your notebook through dedicated Lab tools (`read_notebook`, `inspect_variables`, `insert_cell`, `update_mentor_cell`, `delete_mentor_cell`, `lab_summary`), optional read-only Knowledge Graph tools (`list_sessions`, `list_propositions`), and project-scoped file readers (`read`, `ls`, `find`, `grep`):
- Clicking **Wrap up** (or asking to wrap up) has the mentor record a structured `lab_summary` card linking remaining conceptual gaps to Knowledge Graph node IDs with one-click **Teach these** and **Practice these** session starters (without mutating the Knowledge Graph directly).

- The mentor **owns only unedited mentor cells** (`author: "mentor", learnerEdited: false`).
- Once you author a cell or edit a mentor cell (`learnerEdited: true`), mentor updates/deletions to that cell are hard-refused so your code is never silently overwritten.
- Standard Jupyter nbformat v4.5 is always preserved on disk with Twig metadata stored cleanly under `metadata.twig`.

## Archived Capstone Sessions

Pre-existing `kind: "capstone"` records remain visible under **All** in the sidebar with an archived badge and open as read-only transcripts (turns and capstone creation are disabled).
