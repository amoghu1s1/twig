# Changelog

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
