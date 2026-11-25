# Implementation Plan — Twig Lab v2

Reference specification for **Twig Lab v2** (`kind: "lab"`), extending v1 based on real usage feedback (including the *Python lift simulater* session).

## Pillars

1. **Explicit Nudge-Level Control (`nudge` | `balanced` | `direct`)**
   - Toolbar 3-mode coaching selector (`Nudge` · `Balanced` · `Direct`) persisted on `ChatRecord.lab.nudgeLevel`, plus `lab.defaultNudgeLevel` in **Settings → General → Twig Lab**.
   - Server-tracked `failedRunCount` per cell and transcript-derived `priorMentorNudges` compute a per-cell coaching stage (`pointer_only` vs `escalate_ok` vs `direct`) surfaced in `read_notebook` and reinforced in `src/agent/prompts/lab/10-doctrine.md`.
   - Under default `nudge` mode, the first mentor response to a failing cell gives only a diagnostic pointer (no drop-in implementation fix) unless explicitly requested or after a prior nudge / second failing run.
   - Cell header quick presets: *Hint only*, *Check my work*, *Explain*, *Show fix*.

2. **Structured Check Pass/Fail Status, Stale Detection & Milestones**
   - `python_kernel.py` evaluates top-level `assert` statements and `def test_*()` functions independently, emitting structured `LabCheckCase[]` + `checkPassed`, `status`, `passedCount`, `totalCount`, `summary`, and `ranAt`.
   - Every executed cell records `sourceHashAtRun` and `lastExecutedAt` under `metadata.twig`. Any modified code cell (or passing Check cell downstream of a newly edited/executed code cell) is flagged `stale` in both the UI and `read_notebook`.
   - Notebook pane renders a top **Milestones** strip (`passed/total`, clickable `✓` / `✗` / `↻` / `○` pills, and **Run checks**); `read_notebook` exposes `milestones` in both text and structured `details` even before checks run.

3. **Multi-File Python Workflow (Read-Only Mentor, Learner Extraction)**
   - Before every cell run, `python_kernel.py` checks `st_mtime_ns` of loaded modules inside `workspaceDir`, calls `importlib.reload`, updates `from mod import Symbol` bindings in `_namespace`, and reports `reloadedModules` + `[auto-reloaded: ...]`.
   - One-click **Extract `.py`** modal on code cells extracts classes/functions into a new or existing workspace `.py` module with optional import replacement.
   - Workspace Files drawer adds `+ Folder`, inline file rename, `Ctrl/Cmd+S` save in CodeMirror, and `Insert import` on `.py` modules. Mentor stays read-only on workspace `.py` files.

4. **Knowledge Graph Bridge (`lab_summary` Gap Card & Seeded Starts)**
   - When graph tools are enabled, the Lab mentor receives read-only `list_sessions` and `list_propositions`, plus `lab_summary` (whose gap `targets` validate against real graph nodes without mutating the graph).
   - **Wrap up** button (or direct mentor summary) emits `LabSummaryCard` in the transcript with clickable **Teach these** and **Practice these** buttons that launch pre-seeded sessions via `SessionStarter`.

## Deferred to v3

- Side-by-side idiomatic diff/compare cards & Jupyter timing magics (`%time` / `%%time` / `%timeit`)
- Standalone external `.ipynb` import wizard
- Non-Python kernel adapters (JS/TS, C++, Rust, SQL)
