# Upstream 0.6.1 plugin integration — handoff

Last updated: 2026-11-13 11:20
Branch: `integrate/upstream-0.6`
Base merge commit: `6cc02786`
Latest code/test head: `44285fe4` (later commits are docs only)

## Sweep resumed (2026-11-13 11:20)

- The 11:05 STOP block no longer applies; the CEO cleared the sweep.
- Files 241–280 are green, including the capped 246–250 rerun (84/84, 489 MB peak).
- Batch 8a (files 281–285): **23 pass, 0 fail**.
- Batch 8b (files 286–290): **32 pass, 0 fail** after `0b3626da` restored
  image-only answer thinking in `AnsweredCard`.
- Batch 8c (files 291–295): 35 pass + 4 fail; `c1c27890` fixed stale steer
  admission, `29358ee6` aligned two native-image cases with Twig's attachment
  policy → **37 pass, 2 skipped, 0 fail**.
- Batch 8d (files 296–300): **45 pass, 0 fail**.
- Batch 8e (files 301–305): 37 pass + 2 fail; `5b073cc7` restored Twig's
  `Composer` `defaultDropTarget`/`fileInsertion` props → **39 pass, 0 fail**.
- Batch 8f (files 306–310): **19 pass, 0 fail**.
- Batch 8g (files 311–315): **74 pass, 0 fail**.
- Batch 8h (files 316–320): **51 pass, 0 fail**.
- Batch 8i (files 321–325): **93 pass, 0 fail**.
- Batch 8j (files 326–330): 97 pass + 3 fail in `provider-tracing`; `099ad5d8` removed the duplicate side-chat include and the broad `data/**/*` globs → **100 pass, 0 fail**.
- Batch 8k (files 331–335): 89 pass + 2 fail; `37ee241b` parked the two upstream `QuestionDockBar` preview cases (Twig teaser retained) → **89 pass, 2 skipped, 0 fail**.
- Batch 8l (files 336–340): **60 pass, 0 fail**.
- Batch 8m (files 341–345): 110 pass + 5 fail; `253dc976` wrapped media-card fixtures and parked the upstream teaser-math bar case → **114 pass, 1 skipped, 0 fail**.
- Batch 8n (files 346–350): **38 pass, 0 fail**.
- Batch 8o (files 351–355): **120 pass, 0 fail**.
- Batch 8p (files 356–360): **70 pass, 0 fail**.
- Next sweep position: file **361**. No test/build processes remain.

This file is the source of truth for the in-progress upstream integration. Read it
before touching the branch. The session/harness has a habit of cutting long shell
calls; use short test batches and re-check this file rather than rerunning one giant
`npm test`.

## Goal

Integrate upstream LearnHarness 0.6.1 (plugin system + overlapping feature work) into
Twig while keeping the Twig implementations we chose to retain.

## Decisions (owner-approved)

| Area | Decision |
| --- | --- |
| Plugin host | Take upstream's plugin host, APIs, loader, build/stage pipeline, settings, surfaces and submissions. |
| Core plugin catalog | Ship **only `rich-code-blocks`**. Do not ship upstream Flashcards, Coding Questions or Drawing Pad. |
| FSRS / Anki | Keep Twig native. Do **not** pluginize. Review sessions remain ordinary practice sessions. |
| Drawing board | Keep Twig's persistent scratchpad + calculator. Do **not** adopt upstream Drawing Pad. |
| Themes | Keep Twig's theme system, first paint and desktop chrome sync. |
| Side questions | Keep Twig inline side-question threads; do not adopt the floating side companion. |
| SVG | Keep Twig's `svg` fence renderer; take upstream native/security work where compatible. |
| Code practice | Keep Twig's native `code-exercises` tool and sandboxed runtimes; do not ship the coding plugin. |
| Code blocks | Keep Twig's ordinary code/table/mermaid renderer; layer upstream `PluginCodeBlock` dispatch over it so the Rich Code Blocks plugin can render `smiles`/`abc`/`tikz`. |

## What was done

### Merge strategy

- Added the `upstream` remote (`https://github.com/amosblomqvist/learnharness`).
- Merged `upstream/main` into Twig with a Twig-preserving conflict policy:
  `git merge -X ours --no-commit --no-ff upstream/main`.
- Resolved the three modify/delete conflicts in favor of Twig:
  - `components/attach-files-button.tsx` stays deleted (Twig's consolidated add-context).
  - `src/agent/subagents/bg-llm-semaphore.ts` stays (Twig's permit gate).
  - `tests/svg-native-render.test.ts` stays deleted (Twig SVG renderer).
- Commit `6cc02786` is the merge checkpoint.

### Plugin host integration (commit `8be492ce`)

- `PluginsProvider` in `app/layout.tsx`; `instrumentation.ts` initializes the server host.
- Plugin manager/provider, loader, assets, lifecycle, settings section/pages, sidebar
  actions, plugin chrome, top-bar actions, shortcuts, surfaces, tool/question/problem
  renderers, submission interception and submission images.
- `PluginCodeBlock` dispatch in Twig's `components/md-blocks.tsx` after the mermaid/svg
  branches; Twig's copy corner and ordinary code renderer remain the fallback.
- Server: plugin transport, host, learning data, inference, workers, agents, documents,
  background tools, question/problem handling, plugin worker activity.
- Core/build:
  - `package.json`: `plugins:setup`, `plugins:build-core`, `plugins:build-authoring`;
    plugin build steps in `dev`/`build`/`desktop:dist`.
  - CI/release workflows run `plugins:setup`.
  - `scripts/build-server.mjs`: stages Core plugin payload, copies the native loader,
    builds the authoring bundle, and **strips traced repo `data/`** instead of shipping it.
  - `scripts/smoke-server.mjs`: verifies `/api/plugins`, Core plugin activation/assets,
    external native plugin loading, and Pyodide.
- Plugin core tests pass: `core-plugins`, `core-plugin-build`, `plugin-host`,
  `plugin-frontend`, `plugin-integration`, `plugin-authoring-bundle`,
  `rich-code-blocks-instructions`, `plugin-submission-contracts`.

### Native feature decisions (commit `38fc46c0`)

- `core-plugins.json` now contains only `rich-code-blocks`.
- Kept Twig themes, side questions, FSRS/Anki, scratchpad/calculator, code exercises,
  SVG fences, readings, mistakes and capstone.
- Added side-chat compatibility exports for the plugin host:
  `sideConversationEntries`, `sideSegmentId`, `sideEntryPoints`,
  `SideChatService.snapshot`.
- Added plugin-side compaction projection support in `src/server/compaction.ts`.
- Restored keyboard dialog semantics/plugin Shift+Tab routing in
  `components/keyboard-shortcuts.tsx`.
- Tightened composer image shape validation: explicit `type`/`mimeType`/`data` plus the
  draft-local `id`; URL/path fields are rejected.
- Documented the native decisions in `README.md`, `CHANGELOG.md`,
  `docs/plugin-architecture.md`, `docs/plugin-authoring.md`,
  `docs/plugin-examples.md`.

### Test/fixture fixes after the integration

- `21fe3b92`: Twig desktop header, InteractionLayersProvider in capstone/appearance
  fixtures, `matchMedia` stub, plugin docs.
- `5e59c57b`: demo/visual artifacts use the native fake renderer for the saved-source
  test, and SSR fixtures provide InteractionLayersProvider.
- `55d0433b`: parked upstream `commit-input` tests (Twig ruling is Escape-discards).
- `6a97b3f4`: allowed the draft-local image `id` in `parseComposerImages`; parked the
  combined host-markdown/plugin-owner fixture that hangs in linkedom.
- `f6dcc4e2`: finished the plugin-host contract regressions:
  - regenerated `docs/plugin-api/*` from the current Twig contracts;
  - reserved Twig's file/web/media/capstone builtin tool names against plugins;
  - projected live `content/details/isError` into tool parts for plugin renderers;
  - used Twig's `x-twig-desktop` capability header in the document-route test;
  - provided interaction layers/MutationObserver to model-label fixtures;
  - skipped the two upstream tests that assume Escape-commits settings behavior and
    the literal-LaTeX-in-code markdown fixture (Twig behavior documented in the test).

## Verification completed

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | 0 errors |
| `npm run lint` | 0 errors, 1 pre-existing warning (`tests/source-name-ui.test.tsx`) |
| `npx next build` | pass |
| `node scripts/build-server.mjs` | pass; packaged core = `rich-code-blocks` only; no `data/` |
| `node scripts/smoke-server.mjs` | pass; plugin host + core/external plugins + Pyodide |
| Plugin/host batch | 133/133 |
| Chat/composer/dock/opening/settings batch | 272/272 |
| Themes/review/scratchpad/side-question/keyboard/SVG batch | 354/354 |
| Review/Anki | 144/144 |
| Scratchpad/calculator | 50/50 |
| Demo/visual artifacts | 51/51 |
| Image composer | 24/24 |
| Batch 1 (40 files) | 542 pass, 0 fail |
| Batch 2 (40 files) | 432 pass, 0 fail |
| Batch 3 (40 files) | 417 pass, 28 fail — all in `tests/commit-input.test.tsx` (now parked) |
| Batch 4a (files 121–140, excluding parked/headless) | 263 pass, 0 fail |
| Batch 4b (files 141–160, excluding headless) | groups green: 87 + 69 + 56 + 30; `host-markdown-math` second case skipped |
| Batch 5a (files 161–170) | 157 pass, 0 fail |
| Batch 5b (files 171–180) | 109 pass, 0 fail |
| Batch 5c (files 181–190) | initially 3 fixture failures; `model-provider-labels` fixed → 10/10 |
| Batch 5d (files 191–200) | 146 pass, 0 fail |
| Batch 6a (files 201–210) | 108 pass + 1 skipped (`passive-tooltip` Escape-commits case) |
| Batch 6b (files 211–220) | 145 pass, 0 fail |
| Batch 6c (files 221–230) | plugin API reference stale; regenerated → 4/4 |
| Batch 6d (files 231–240) | plugin contributions + document proxy fixed; plugin-renderers fixed |
| Batch 7a (files 241–250) | 71/71 for 241–245; 84/84 for 246–250 after `02891b6e` (489 MB capped peak) |
| Batch 7b (files 251–260) | 59 pass, 0 fail |
| Batch 7c (files 261–270) | 196 pass, 0 fail |
| Batch 7d (files 271–280) | 107 pass + 1 failure; `plugin-renderers` fixed → 14/14 |
| Batch 8a (files 281–285) | 23 pass, 0 fail |
| Batch 8b (files 286–290) | 31 pass + 1 fail; `0b3626da` restored answer-thinking images → 32/32 |
| Batch 8c (files 291–295) | 35 pass + 4 fail; `c1c27890` + `29358ee6` → 37 pass, 2 skipped |
| Batch 8d (files 296–300) | 45 pass, 0 fail |
| Batch 8e (files 301–305) | 37 pass + 2 fail; `5b073cc7` → 39 pass, 0 fail |
| Batch 8f (files 306–310) | 19 pass, 0 fail |
| Batch 8g (files 311–315) | 74 pass, 0 fail |
| Batch 8h (files 316–320) | 51 pass, 0 fail |
| Batch 8i (files 321–325) | 93 pass, 0 fail |
| Batch 8j (files 326–330) | 97 pass + 3 fail; `099ad5d8` → 100 pass, 0 fail |
| Batch 8k (files 331–335) | 89 pass + 2 fail; `37ee241b` parked bar cases → 89 pass, 2 skipped |
| Batch 8l (files 336–340) | 60 pass, 0 fail |
| Batch 8m (files 341–345) | 110 pass + 5 fail; `253dc976` → 114 pass, 1 skipped |
| Batch 8n (files 346–350) | 38 pass, 0 fail |
| Batch 8o (files 351–355) | 120 pass, 0 fail |
| Batch 8p (files 356–360) | 70 pass, 0 fail |

A full monolithic `npm test` was never completed. The cut-off shell calls were **not** a
harness limit. The morning retries (09:25, 09:27, 09:35, 09:43) each died at the
systemd-oomd kill that followed (09:26:34, 09:29:04, 09:36:47, 09:45:22): the test suite
was the trigger, not the harness. `tests/plugin-markdown.test.tsx` compared a linkedom
element to `null`; the selector matched Twig's retained code-block copy corner, so the
assertion failed. Node's assert then inspected the linkedom element graph with
`depth: 1000`, allocation grew without bound (a test child reached 13.4 GB RSS), RAM and
zram swap hit 90%, and systemd-oomd killed the entire agent scope
(`t3code-opencode-*`, `kitty-*`, `app-openbot-*`) — the "opencode crash". Fixed in
`02891b6e`: the test now compares `tagName` primitives and expects the copy corner Twig
keeps. The file passes 9/9 at a 387 MB peak; batch 246–250 passes 84/84 at a 489 MB peak.

Rule for the rest of the sweep: **never pass a DOM node to `assert.equal`/`deepEqual`
when it can be non-null.** Compare `?.tagName ?? null`, `?.textContent`, or a count.
A future failing node comparison reproduces the same machine-wide OOM.

## Remaining work

1. **Finish the test sweep** from file 361 onward (see command below), then re-run the
   earlier failing files. Files 241–360 are green (3 upstream bar cases parked). Most plugin tests have already
   passed individually; the recent failures were fixed in `f6dcc4e2`. Fix real
   failures; park only upstream-only behavior that conflicts with a Twig decision.
   Every batch must run capped (`NODE_OPTIONS=--max-old-space-size=2048`, `timeout 45`).
2. **Audit `-X ours` losses** in non-feature files. The merge deliberately kept Twig on
   conflicts, so check upstream-only security/bug fixes that may have been dropped:
   - `electron/main.cjs` (external-link handling, browser-service isolation)
   - `src/agent/subagents/headless.ts` (Twig version restored; upstream isolation work
     was not adopted)
   - `src/agent/subscription-request-cycle.ts` (we re-added `locallyRejected` /
     `rejectLocalRequest`)
   - `proxy.ts` / `src/server/desktop-access.ts` (Twig uses `x-twig-desktop`; upstream
     used `x-learnharness-desktop`)
   - plugin host security fixes (path traversal, linked authoring source, same-origin)
3. **Re-run final gates** after the test sweep:
   `npx tsc --noEmit`, `npm run lint`, `npx next build`,
   `node scripts/build-server.mjs`, `node scripts/smoke-server.mjs`.
4. **Decide whether to reserve native feature IDs** (`flashcards`, `coding-questions`,
   `drawing-pad`) so community plugins cannot take those names. Currently only catalog
   IDs are reserved.
5. **Release metadata** — package version is still `0.6.1`; the changelog has an
   `Unreleased` section. Do not bump without an owner decision.
6. **Possible follow-ups**:
   - Remove the upstream drawing-pad/flashcards/coding source dirs from the authoring
     bundle if they should not be shipped even as reference kits.
   - Add a Twig-specific note to the plugin API docs if the retained native features
     need to be discoverable.
   - Review the one presentation nuance reported by the settings agent:
     `PluginSidebarActions` switches to two columns at ≥6 children; Twig has six doors.

## Parked tests (`tests/upstream-parked/`)

| File | Why |
| --- | --- |
| `commit-input.test.tsx` | Upstream expects Escape to commit; Twig's ruling is Escape discards. Twig settings/controls suites cover the retained behavior. |
| `host-markdown.test.tsx` | Its `noControls` helper compares matched DOM nodes to `null`; Twig's retained copy corner makes that assertion fail, and Node's assert diff then inspects the linkedom graph without bound (the real "linkedom hang"). Keep the individual SSR/link/mermaid/highlighting coverage elsewhere until the no-controls expectation is reconciled with Twig. |
| `host-markdown-math.test.tsx` (second case) | The literal-overescaped-LaTeX-in-code case hangs the linkedom pipeline; the exact determinant recovery pin remains active. |
| `passive-tooltip.test.tsx` (one case) | Assumes upstream CommitInput Escape-commits; Twig's Escape discards. The other 10 tooltip/layer cases run. |
| `side-chat.test.ts`, `side-chat-*`, `side-conversation-*`, `side-plugin-*`, `side-thread-*`, `use-side-thread-*` | Upstream floating side companion; Twig keeps inline side questions. |
| `headless-isolation.test.ts` | Upstream isolated-page browser service; Twig keeps its own sandboxed browser-service profile and native SVG rasterizer. |

## How to resume

```sh
git switch integrate/upstream-0.6
git status --short          # should be clean except the external-links fix if uncommitted
npx tsc --noEmit
npm run lint
```

Run the remaining tests in small batches. The server restarted repeatedly during this
session; 5-file chunks are the most reliable. Example for the next window:

```sh
bash -c 'mapfile -t files < <(ls tests/*.test.ts tests/*.test.tsx | sed "s|tests/||" | sort | sed -n "241,245p" | sed "s|^|tests/|"); NODE_ENV=test NODE_OPTIONS=--max-old-space-size=2048 timeout 45 npx tsx --test "${files[@]}"'
```

Then continue with `sed -n "246,250p"`, etc. Do not run one giant `npm test`; a
runaway test assertion can exhaust RAM/zram and oomd kills the agent. Keep
`NODE_OPTIONS=--max-old-space-size=2048` in every batch: it bounds a pathological
assert at 2 GB and leaves the machine (and this session) alive. A detached batch
runner exists at `/tmp/opencode/run-all-tests.sh` but it is also killed on
session/provider restart.

## Current working-tree note

The external-links fixture fix is committed in `b530fba5`/`f6dcc4e2`. If
`git status` shows anything else, inspect it before continuing; the handoff should be
the only deliberate working-tree artifact.

## Key files added/changed

- `app/layout.tsx`, `instrumentation.ts`, `components/plugins.tsx`,
  `components/plugin-*`, `src/core/plugin-*`, `src/server/plugin-*`,
  `src/agent/plugin-*`, `app/api/plugins/*`, `app/plugins/*`
- `components/chat.tsx`, `components/composer*.tsx`, `components/question-dock.tsx`,
  `components/session-core.ts`, `components/settings/*`, `components/sidebar.tsx`,
  `components/md-blocks.tsx`
- `src/core/{input-events,native-messages,view,phases,events,ports,settings,
  settings-resolution,keyboard,session-markdown,compaction,side-chat,images}.ts`
- `src/server/{chat-handler,index,jobs,observability,compaction,side-chat}.ts`
- `scripts/build-server.mjs`, `scripts/smoke-server.mjs`,
  `scripts/smoke-core-plugins.mjs`, `core-plugins.json`, `package.json`, CI workflows
- `README.md`, `CHANGELOG.md`, `docs/plugin-*.md`
