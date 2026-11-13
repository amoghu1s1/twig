# Changelog

## Unreleased — upstream 0.6.1 plugin integration

### Plugins

- **Plugin host** — upstream's plugin lifecycle, trusted local frontends/backends, plugin-owned data, settings, actions, surfaces, submissions, workers and document conversion are integrated.
- **Core plugin catalog** — **Rich Code Blocks** is the shipped optional Core plugin. Drawing Pad, Flashcards and Coding Questions are not shipped because Twig keeps those features native.
- **Code-block dispatch** — plugin code-block renderers now layer over Twig's ordinary code renderer, so `smiles`, `abc` and `tikz` fences render while ordinary code keeps Twig's copy/theme behavior.

### Preserved native features

- **FSRS-6 + Anki** — native review scheduling and Anki export, with review sessions still opening ordinary practice sessions.
- **Drawing board** — Twig's persistent scratchpad, calculator and inline SVG figures.
- **Themes, side questions, SVG and code exercises** — Twig's implementations remain in place; the upstream side companion, headless browser isolation and native coding plugin are not adopted.

### Build and packaging

- Plugin setup, Core package staging, authoring-kit generation and packaged-server smoke checks.
- Packaged-server payload now strips traced repo `data/` and validates the Core plugin payload before shipping.

## 0.6.1 — 2026-11-09

### Teaching

- **Clearer learner-facing prose** — rewrote the shared, teacher, prober, practice, capstone, readings, discuss, and side-chat prompts in natural explanatory prose. Every action now has a concrete actor, and the prompts reject compressed pseudo-English such as "the limit removes the corner." Added `docs/style-rubric.md` and `npm run style-check`.
- **Direct answers** — scoped the discovery method to teaching a new step, so direct questions get a direct answer first.

### Branding

- **New app icon** — replaced the mark with the orange connected-circle emblem on a transparent background for macOS, Windows, Linux, and the web app.

## 0.6.0 — 2026-11-08

Twig's first feature release after syncing upstream LearnHarness 0.5.0.

### Learning

- **FSRS-6 review** — completed practice becomes a derived spaced-repetition queue; review sessions are ordinary practice sessions and review state is never written back to the graph.
- **Code exercises in four languages** — Python (bundled Pyodide), JavaScript and TypeScript (opaque-origin workers with `sucrase` type-stripping), and C++ (locally detected `clang++`/`g++` with bounded compile/run).
- **Read by sentence** — full-screen sentence-by-sentence reading with blur/hide/dim, adjustable type, browser-voice default, optional ElevenLabs read-aloud, `Mod+R`, and `gg`/`G` session navigation.
- **Readings** — primer, overview, deep-dive, recap and node readings from a frozen lesson snapshot, with citation checks and Discuss.
- **Capstone projects** — pitch a project, lock a file-verifiable brief, get a read-only review and a gap report that can seed teaching or practice.
- **Mistakes review** — nine-type error taxonomy, per-miss analysis, opt-out and a rolling cost cap.

### Practice and notes

- **Side questions** — ask about a passage without derailing the lesson; threads stay attached to the block.
- **Per-lesson notes** — resizable notes panel, quote-to-notes, stale-write warning.
- **Quote into composer** — quote selected tutor text directly into a reply.
- **Edit last message** — durable rewind of transcript, plan, graph traces, jobs and queued steers.
- **Scratchpad and calculator** — pressure-sensitive drawing sidebar, draggable scientific calculator, inert `svg` figures.

### Context and exports

- **Session attachments** — content-addressed PDFs, EPUBs and images under `data/attachments/`, with previews, scoped readers, reversible detach and zip-bomb caps.
- **Graph exports** — Anki with stable node ids and four note types, Obsidian vault export, and a tidy-graph proposal workflow.
- **Full themes** — eleven presets, Dark/Light/System mode, server first paint, Electron chrome sync and WCAG-checked colors.

### Reliability and security

- Upstream 0.5.0: paperclip/path attachments, learner-image snapshots, folder and PDF imports, Exa/Firecrawl/Ollama search, file-access restrictions, atomic store writes, Claude CLI guards, projection/recovery fixes.
- Twig fixes: Deepgram training opt-out, compaction lost-write and research-brief fixes, cancelled-import audit gate, updater feed restriction, IPC/credential hardening, Claude CLI abandoned-stream recovery, graph read hoist, empty-answer recovery.
- Fork security hardening: SSRF-safe web fetch, safe regex and pre-read caps, demo/SVG sandbox, sandboxed Chrome fallback.

### Branding

- Transparent Twig mark, README banner, app icon for macOS/Windows/Linux, Twig naming in docs and graph exports.

### Notes

- macOS builds are signed and notarized when the repository signing secrets are configured; otherwise the release workflow publishes an unsigned DMG/ZIP with a warning.
