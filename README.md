<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/twig_logo_transparent.png">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/twig_banner.png">
    <img src="docs/assets/twig_banner.png" alt="Twig" width="640">
  </picture>
</p>

<p align="center"><strong>An agent harness for learning.</strong></p>

<p align="center">
  <a href="https://github.com/amoghu1s1/twig/releases">Download</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="https://github.com/amoghu1s1/twig/issues">Issues</a> ·
  <a href="https://discord.gg/5tCHHQEB2e">Discord</a>
</p>

> Twig is a fork of [LearnHarness](https://github.com/amosblomqvist/learnharness), renamed and packaged separately so both can run side by side. Original work © Amos Blomqvist, AGPL-3.0.

Twig uses AI agents to plan and teach lessons from your current understanding to your goal. It builds a detailed picture of what you understand and how you reason. That picture is updated as you learn.

Instead of just giving you an explanation, it uses your answers and thinking to decide what you need next. Teaching builds understanding one reasoning step at a time. Practice makes it usable. A persistent knowledge graph carries it across sessions.

![Twig teaching session](docs/assets/teaching-session.png)

## What is different in Twig

Twig keeps LearnHarness's teaching model and adds the parts that matter for daily personal use.

### Learn

- **FSRS-6 review** — completed practice becomes a spaced-repetition queue. Review sessions are ordinary practice; nothing is written back to the graph. [Review plan](docs/review-plan.md)
- **Code exercises in four languages** — runnable Python, JavaScript, TypeScript and C++ inside lessons. Python uses bundled Pyodide, JS/TS an opaque-origin worker, and C++ a locally detected `clang++`/`g++` with bounded compile and run limits.
- **Read by sentence** — full-screen reading one sentence at a time, with blur/hide/dim, adjustable type, optional ElevenLabs or browser voice, `Mod+R`, and `gg`/`G` navigation. [Keyboard](docs/keyboard.md#read-by-sentence)
- **Readings** — primer, overview, deep-dive, recap and node readings from a frozen lesson snapshot. Citations are limited to sources actually fetched in that run; Discuss lets you talk through a passage. [Readings](docs/readings.md)
- **Mistakes review** — every miss is classified and analyzed on a Mistakes page with a short why. The analyst is opt-out and cost-capped.

### Discuss and keep track

- **Side questions and notes** — ask about a passage without derailing the lesson; each thread stays attached to its block. Per-lesson notes support quote-to-notes and survive reloads.
- **Quote and edit** — quote tutor prose directly into your reply, or rewrite the last sent prompt or parked steer with a durable rewind of the transcript, plan, graph traces, jobs and queued steers.
- **Capstone projects** — pitch a real build from graph propositions, lock a file-verifiable brief, then get a read-only directory review and gap report. [Capstone](docs/capstone.md)

### Context and tools

- **Session attachments** — attach PDFs, EPUBs, images and other files from the composer. Content is stored once by hash, previewed from the session, and read through scoped PDF/EPUB tools; removal is reversible. [Add context](docs/getting-started.md#use-local-files-in-a-session)
- **Themes** — eleven presets plus Dark / Light / System mode, server first paint, Electron chrome sync, and WCAG-checked muted and status colors. [Themes](docs/themes.md)
- **Graph exports** — Anki notes with stable ids, Obsidian Markdown, and a tidy-graph review that proposes merges, splits and connections. [Anki](docs/anki.md) · [Obsidian](docs/obsidian.md) · [Tidy graph](docs/tidy-graph.md)
- **Scratchpad and calculator** — a pressure-sensitive drawing sidebar with undo, eraser and straight lines; a draggable scientific calculator; and inert `svg` figures rendered directly in lessons.

### Under the hood

- **Upstream 0.5.0** — carries LearnHarness's attachments, learner-image snapshots, folder and PDF imports, Exa/Firecrawl/Ollama search, file-access restrictions, atomic store writes, Claude CLI guards, and projection/recovery fixes.
- **Defensive tooling** — SSRF-safe web fetch redirects, bounded regex and pre-read limits, and a sandboxed demo/SVG surface.
- **Twig identity** — the transparent Twig mark, app title, package and desktop identity, app icon and release metadata are Twig-branded; attribution to LearnHarness remains.

## How it works

1. **Measure.** Before teaching, the agent finds where your understanding ends on each part the lesson depends on. Your answers, confidence, and thinking show it where to start.
2. **Plan.** It works out a dependency map from that starting point to your goal. You can see the plan, and the lesson adapts when your understanding turns out different.
3. **Teach.** Each step builds on something you already understand. You predict, get an explanation, and check your understanding. Confusions are repaired before anything is built on them. The aim is for the goal to feel obviously true, not merely familiar.
4. **Practice.** Separate sessions pose varied problems that require the right knowledge to come to mind without being named first. Problems and hints adapt to your reasoning. Completed practice feeds the spaced-review queue.

**Think out loud.** The thinking fields let you explain your reasoning, uncertainties, and reactions in your own words. This is how the agent gets a detailed picture rather than just a record of right and wrong answers. You can type or use dictation.

**Read at your pace.** *Read by sentence* turns a finished teacher passage into a full-screen reading surface: one sentence at a time, optional read-aloud, and keyboard navigation. *Readings* can also generate a primer, overview, deep dive, recap or node-specific reading from the lesson's frozen snapshot.

**Bring your files.** In the desktop app, attach PDFs, EPUBs, photos, or other files with the paperclip, or drag them in. Files can stay where they are (the message carries the path) or be attached once to the session and stored locally by content hash; the agent gets a scoped reader for each.

The agent can also research questions in the background, create visual explanations, show your own images in the lesson and mark them up with arrows and labels, and build interactive demonstrations.

## Knowledge that carries forward

What you are taught accumulates as propositions and reasoning chains: individual claims and the premises that lead to them. The graph shows this structure, with links back to the source sessions. You can also import notes.

Future teaching sessions can read the graph instead of starting from scratch. Practice sessions can draw their material from it. It stores the ideas and their connections, not ratings of your ability.

![Twig knowledge graph](docs/assets/knowledge-graph.png)

## Install

**[Download the latest Twig release](https://github.com/amoghu1s1/twig/releases)**. Builds are currently available for **Apple Silicon macOS**, **Windows x64**, and **Linux x64**.

| Platform | Package | Install |
| --- | --- | --- |
| macOS (Apple Silicon) | `Twig-<version>-arm64.dmg` | Open the DMG and drag **Twig** into **Applications**. Builds are signed and notarized when release signing credentials are configured; otherwise macOS may show a security warning. Intel Macs are not supported. |
| Windows (x64) | `Twig-<version>-x64-setup.exe` | Run the per-user installer. It is currently unsigned, so Windows may show an “unknown publisher” or SmartScreen warning. |
| Linux (x64) | `Twig-<version>-x86_64.AppImage` | `chmod +x Twig-*.AppImage` then run it. AppImage is the primary Linux download. |
| Debian / Ubuntu (x64) | `Twig-<version>-amd64.deb` | `sudo apt install ./Twig-*.deb`. Updates through the package manager may ask for your password. |

Twig is distributed through GitHub Releases; the project does not publish a Homebrew, Flatpak, AUR, or distro package feed. The AppImage runs on most x64 distributions, including Arch-based systems.

### First launch

1. Open Twig.
2. Go to **Settings → Providers** and connect a provider API key, a supported subscription (ChatGPT, GitHub Copilot or Grok), an installed [Claude Code CLI](docs/claude-code.md), or a [custom OpenAI-compatible endpoint](docs/custom-providers.md), including a local model server.
3. Choose **Strong**, **Cheap** and **Vision** models under **Settings → Agent**. There are no factory model selections.
4. Start a session with what you want to understand.

Optional dictation and web search use separate service keys. Web research can use Tavily, Brave, Exa, Firecrawl, or Ollama search in **Settings → Providers → Search**; Ollama search uses its hosted service, not a local model server.

Packaged apps update in-app through GitHub Releases. Check status or run a manual check under **Settings → General**. See [Getting started](docs/getting-started.md) for model setup, dictation, files and notes imports, and [context, caching, and costs](docs/compaction-accounting.md) for cache and cost details.

## Your keys, your data

- **Your keys and models.** No Twig subscription or markup. Billing depends on your provider, CLI configuration, subscription, or local setup. The live cost meter estimates known API costs, not subscription, CLI, or custom-endpoint charges.
- **Local storage.** Your chats, graph, settings, and API keys live on your machine. Learning records are plain files you can inspect.
- **External services.** Models run through your configured providers. Model requests send the context needed for the task; web research and dictation also contact external services. Local storage does not mean offline processing.
- **Inspectable behavior.** System prompts are visible and editable. The app is open source under the AGPL-3.0 license.

## Development and support

```bash
npm ci
npm run plugins:setup
npm run dev        # http://localhost:3000
npm test           # fixtures and fake providers
```

See the [documentation index](docs/README.md) for all guides, [development](docs/development.md) for setup and checks, [architecture](docs/architecture.md) for the runtime, [keyboard shortcuts](docs/keyboard.md), [themes](docs/themes.md) for the theme file format, and [desktop builds and releases](docs/desktop-release.md).

For trusted local plugins, start with the [authoring guide and capability map](docs/plugin-authoring.md). It links the question, practice-problem, submission, view-context and UI contracts. Use [`examples/plugins/`](examples/plugins/) for small runnable templates, [`plugins/`](plugins/) for feature source projects, and the [host architecture](docs/plugin-architecture.md) for internals.

Questions, bug reports, and feature requests: [GitHub Issues](https://github.com/amoghu1s1/twig/issues).

Security vulnerabilities: report privately as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[AGPL-3.0](LICENSE)

The app is free and open forever. If we ever charge for anything, it will be for convenience — managed keys, hosting — never for features you can run locally.
