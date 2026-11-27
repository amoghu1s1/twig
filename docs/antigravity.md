# Antigravity CLI (`agy acp`)

Twig can use an externally installed **Antigravity CLI (`agy`)** as a model provider via the official Agent Client Protocol (`agy acp --stdio`). The CLI owns authentication, routing, model access, and billing.

## Set up

1. [Install and authenticate Antigravity CLI (`agy`)](https://antigravity.google/docs/getting-started) outside Twig, on **the machine running the Twig server**, under its OS user. No always-running CLI process is needed.
2. Make `agy` discoverable in that server's `PATH` or a common user/native installation location (including `mise` shims, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`). On Windows, a directly runnable `agy.exe` is required; `.cmd` wrappers alone do not qualify.
3. Enable **Settings → Providers → External CLI → Antigravity**. This app-wide opt-in is **off by default**. Use **Check again** to refresh installation status and rediscover available models.
4. Select any discovered Antigravity model in your model slots or chat picker.

The minimum version is **1.5.18** ([contract](../src/core/contracts/antigravity.ts)).

## What goes through `agy acp`

Twig keeps control of its agent loop, tools, questions, saved history, and jobs:

- **Dynamic model catalog**: When enabled or refreshed, Twig runs a lightweight `initialize` → `session/new` → `session/close` probe to discover the models and per-model thinking levels available to your signed-in account.
- **Process & environment isolation**: Each child runs without a shell (`agy acp --stdio --include-default-customizations=false`) in an empty temporary working directory with Twig key-store env vars stripped (`externalCliEnv()`). Native user CLI authentication remains available.
- **System prompt & tools**: Twig appends its tutor/agent system prompt via `_meta.antigravity.systemPrompt.append` and exposes Twig's declared tools through a token-protected loopback Streamable HTTP MCP server (`learnharness`).
- **Tool permission gating**: In `session/request_permission`, Twig approves only declared `mcp_learnharness_*` tools and denies (`reject_once`) all built-in `agy` tools so the model recovers using Twig's tools. If a non-bridge tool ever executes to completion, the turn fails closed.

## Session reuse, replay, and cancellation

- Twig reuses a live `agy acp` process and session across both tool-call / learner-question pauses **and** consecutive user turns in the same chat (preserving multi-turn prompt caching).
- Live processes expire after **10 minutes** idle.
- On edit, retry, compaction, model/thinking/system-prompt/tool/env change, or idle expiry, Twig retires the old process and starts fresh with a full labelled transcript replay (preserving user/tool images).
- Abort sends `session/cancel` and terminates the child; cleanup removes temp directories and closes the MCP bridge.

## Usage and billing

- Token counts come from `agy acp` (`usage` on `session/prompt` results) and context window size comes from `usage_update`.
- Dollar costs remain **unpriced** and menus say **CLI billing**.

## Maintainer entry points

- [`src/agent/antigravity/`](../src/agent/antigravity/) — binary discovery, version check, JSON-RPC ACP client, dynamic catalog probe, loopback HTTP MCP bridge, transcript replay, multi-turn + tool-pause session reuse, and stream adapter.
- [`src/server/antigravity.ts`](../src/server/antigravity.ts) & [`src/server/antigravity-config.ts`](../src/server/antigravity-config.ts) — opt-in availability and same-origin status/probe route (`GET /api/antigravity`).
- [`components/settings/antigravity-status.tsx`](../components/settings/antigravity-status.tsx) — Settings UI under **External CLI**.
