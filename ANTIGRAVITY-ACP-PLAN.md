# Antigravity ACP (`agy acp`) Provider Plan

Implementation plan for adding **Antigravity CLI (`agy acp`)** as an External CLI model provider in Twig, following the same product boundaries as `claude-code` while using the official Agent Client Protocol (ACP) stdio interface.

---

## 1. Agreed Design Decisions

| Decision | Choice |
| --- | --- |
| **Provider identity** | Provider ID `"antigravity"`, label `"Antigravity"`, API `"antigravity-acp"`, settings key `settings.antigravity.enabled` (off by default), status endpoint `GET /api/antigravity`, eligible for all slots & background roles (same as `claude-code`). |
| **Model catalog** | Dynamic discovery via lightweight `agy acp` probe (`initialize` → `session/new` → `session/close`), extracting base models from `configOptions[id="model"]` and per-model thinking levels from `models.availableModels`. Cached in memory (like ChatGPT/subscription catalogs) and refreshed when enabled, on **Check again**, or on catalog refresh. |
| **Process & session lifecycle** | Reuse a live `agy acp` process + ACP session across consecutive user turns in the same chat **and** across tool-call / learner-question pauses (10-minute idle timeout). Fall back to a fresh process + labelled transcript replay on edit, retry, compaction, config/model/prompt/env change, or idle expiry. |
| **Tool & prompt isolation** | Empty temp `cwd`, `--include-default-customizations=false`, `externalCliEnv()` (strips Twig key-store vars while keeping native user CLI auth), Twig system prompt via `_meta.antigravity.systemPrompt.append`, Twig tools exposed through a token-protected loopback Streamable HTTP MCP server (`learnharness`). In `session/request_permission`, approve only `mcp_learnharness_*` tools (`allow_once`) and deny (`reject_once`) all built-in tools so the model recovers using Twig's tools; fail closed if any non-bridge tool actually executes. Never pass `--dangerously-skip-permissions`. |
| **Settings UI & auth** | Under **Settings → Providers → External CLI** alongside Claude Code. Hands-off external terminal auth (`agy`). Shows version status + discovered model count (or a "sign in via terminal" hint if the catalog probe returns an auth error), plus a **Check again** button. Model menus show `CLI billing` (unpriced) and live context window from `usage_update`. |
| **Code structure** | Self-contained `src/agent/antigravity/` module. Leave `src/agent/claude-code/` untouched to avoid destabilizing its strict `claudecode/toolUseId` invariants and existing test suite; reuse only shared core helpers (`externalCliEnv()`, `cliContextWindowOf`, etc.). |

---

## 2. Verified `agy acp` Wire Protocol Reference (`agy v1.5.18`)

All details below were verified live against `agy acp --stdio --include-default-customizations=false`:

### Launch command
```text
agy acp --stdio --include-default-customizations=false
```
- Runs without a shell (`spawn(binary, args, { cwd: emptyTempDir, env: externalCliEnv(), stdio: "pipe" })`).
- Version check: `agy --version` outputs plain semver (e.g. `1.5.18`).

### `initialize`
Request:
```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
```
Response highlights:
- `agentInfo`: `{ "name": "Antigravity ACP Server", "version": "1.5.18" }`
- `agentCapabilities.promptCapabilities`: `{ "image": true, "audio": false, "embeddedContext": true }`
- `agentCapabilities.sessionCapabilities`: `{ "resume": {}, "close": {}, "load": {}, "list": {}, "additionalDirectories": {} }`
- `agentCapabilities._meta.antigravity`: `{ "tier": true, "systemPrompt": { "append": true } }`

### `session/new`
Request:
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "<emptyTempDir>",
    "mcpServers": [
      {
        "type": "http",
        "name": "learnharness",
        "url": "http://127.0.0.1:<port>/mcp",
        "headers": [{ "name": "Authorization", "value": "Bearer <32-byte-hex>" }]
      }
    ],
    "_meta": {
      "antigravity": {
        "systemPrompt": {
          "append": "<Twig system prompt>"
        }
      }
    }
  }
}
```
Notes:
- **Exact `_meta` nesting matters**: `_meta.antigravity.systemPrompt.append` is honored; top-level `_meta.systemPrompt.append` is ignored.
- During `session/new`, `agy` probes `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource` without auth before calling `POST /mcp` with the `Authorization: Bearer ...` header. The loopback HTTP server should return `404` for `/.well-known/*` and enforce constant-time Bearer token validation on `/mcp`.
- Response returns:
  - `sessionId`
  - `models.availableModels`: flat list of `{ modelId, name }` variants including thinking suffixes (e.g. `gemini-4-neon-low`, `gemini-4-neon-medium`, `gemini-4-neon-high`, `gemini-4-neon-xhigh`, `gemini-3.8-flash-low/medium/high`, `claude-opus-5-5-low/medium/high`, `gpt-oss-120b-medium`).
  - `configOptions`: includes `id: "model"` (base model IDs + display names, e.g. `gemini-4-neon` → `"Gemini 4 Neon"`) and `id: "thought_level"` (`low`, `medium`, `high`, `xhigh`).
  - Combining `configOptions[id="model"]` with `models.availableModels` yields the exact per-model `thinkingLevelMap` in a single `session/new` call.

### Model & thinking level selection
```json
{"jsonrpc":"2.0","id":3,"method":"session/set_config_option","params":{"sessionId":"<sid>","configId":"model","value":"<modelId>"}}
{"jsonrpc":"2.0","id":4,"method":"session/set_config_option","params":{"sessionId":"<sid>","configId":"thought_level","value":"<low|medium|high|xhigh>"}}
```

### `session/prompt` & streaming notifications
Request:
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/prompt",
  "params": {
    "sessionId": "<sid>",
    "prompt": [
      { "type": "text", "text": "..." },
      { "type": "image", "mimeType": "image/png", "data": "<base64>" }
    ]
  }
}
```
Incoming `session/update` notifications (`params.update.sessionUpdate`):
- `agent_thought_chunk`: `{ content: { type: "text", text } }` → pi-ai `thinking_start` / `thinking_delta` / `thinking_end`.
- `agent_message_chunk`: `{ content: { type: "text", text } }` → pi-ai `text_start` / `text_delta` / `text_end`.
- `tool_call` / `tool_call_update`: `{ toolCallId, name, args, rawInput, status }`. MCP tools are prefixed `mcp_learnharness_<toolName>`. Note: `agy` may inject a `toolSummary` field into `args`/`rawInput` in ACP notifications, whereas MCP `tools/call` receives the clean schema-matching `arguments`.
- `usage_update`: `{ used, size }` → sets `cliContextWindow = size` (e.g. `1048576`).
- `available_commands_update`, `config_option_update`, `session_info_update`: ignore during streaming.

Incoming `session/request_permission` (server → client JSON-RPC request):
```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "session/request_permission",
  "params": {
    "sessionId": "<sid>",
    "toolCall": { "toolCallId": "call_...", "name": "mcp_learnharness_<toolName>", "args": { ... } },
    "options": [
      { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
      { "optionId": "deny", "name": "Deny", "kind": "reject_once" }
    ]
  }
}
```
- If `toolCall.name` starts with `mcp_learnharness_` and the stripped name is in Twig's declared tools: record the pending admission `{ toolCallId, name, args }` and respond with `{ outcome: { outcome: "selected", optionId: allowOption.optionId } }`.
- Otherwise (any built-in `agy` tool): respond with `{ outcome: { outcome: "selected", optionId: denyOption.optionId } }`.
- Note: Unlike Claude Code, `agy acp` does **not** pass `toolCallId` in MCP `tools/call._meta`. Instead, correlate each incoming MCP `tools/call` against the permission-approved queue (matching stripped tool name + arguments, stripping `agy`'s extra `toolSummary` from ACP `rawInput` if present) and bind it to the approved `toolCallId`. Hold the MCP `tools/call` Promise open until Twig invokes the stream again with the matching `ToolResultMessage`.

Final `session/prompt` response:
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "stopReason": "end_turn",
    "usage": {
      "inputTokens": 14060,
      "outputTokens": 337,
      "cachedReadTokens": 9588,
      "cachedWriteTokens": 0,
      "thoughtTokens": 301,
      "totalTokens": 23985
    }
  }
}
```
- Map `usage` into pi-ai `AssistantMessage.usage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, zero placeholder `cost`).
- On abort, send `session/cancel` (`{ sessionId }`) and kill the child if it does not settle promptly.
- On clean teardown / idle expiry, send `session/close` (`{ sessionId }`), close the MCP HTTP server, and remove the temp `cwd`.

---

## 3. File-by-File Implementation Checklist

### A. Core contracts & settings (`src/core/`)
- [ ] `src/core/contracts/antigravity.ts`
  - `ANTIGRAVITY_PROVIDER = "antigravity"`
  - `ANTIGRAVITY_LABEL = "Antigravity"`
  - `ANTIGRAVITY_MINIMUM_VERSION = "1.5.18"`
  - `AntigravityStatus`: `{ state: "not-found" | "update-required" | "version-unchecked" | "not-signed-in" | "ready", version: string | null, minimumVersion: string, modelCount: number }`
- [ ] `src/core/index.ts` — re-export Antigravity contract symbols.
- [ ] `src/core/provider-label.ts` — return `ANTIGRAVITY_LABEL` for `ANTIGRAVITY_PROVIDER`.
- [ ] `src/core/settings.ts` — add `antigravity?: { enabled?: boolean }` to `UserSettings` and `sanitizeUserSettings`.

### B. Self-contained Antigravity ACP module (`src/agent/antigravity/`)
- [ ] `constants.ts` — `ANTIGRAVITY_PROVIDER`, `ANTIGRAVITY_API = "antigravity-acp"`, `AntigravityError` enum (`CliNotFound`, `NotSignedIn`, etc.).
- [ ] `binary.ts` — `resolveAntigravityBinary()` / `getAntigravityBinary()` searching `PATH` + known POSIX/Windows dirs (including `~/.local/share/mise/shims`, `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, Nix profiles; `agy.exe` on Windows, no shell).
- [ ] `installation.ts` — bounded `agy --version` (5s timeout, `externalCliEnv()`) + semver comparison against `ANTIGRAVITY_MINIMUM_VERSION`.
- [ ] `acp-client.ts` — stdio NDJSON JSON-RPC 2.0 client for `agy acp` (request ID correlation, timeouts, notification listener, incoming request handler for `session/request_permission`, stderr ring buffer, clean close/kill escalation).
- [ ] `catalog.ts` — `refreshAntigravityModels()` / `antigravityModels()` / `antigravityModel(id)` running an ephemeral `initialize` → `session/new` → `session/close` probe, parsing `configOptions[id="model"]` + `models.availableModels` + `usage_update.size` into `Model<Api>[]` with accurate per-model `thinkingLevelMap`, `input: ["text", "image"]`, and zero placeholder costs. Detects auth errors cleanly so status can report `"not-signed-in"`.
- [ ] `tool-bridge.ts` — token-protected loopback Streamable HTTP MCP server (`learnharness`, 32-byte Bearer token, 404 on `/.well-known/*`), correlating incoming `tools/call` against permission-approved ACP tool calls and holding the response until Twig resolves it with a `ToolResultMessage`.
- [ ] `transcript.ts` — converts Twig `Message[]` to ACP `prompt` blocks (`text` + base64 `image`) for both:
  1. Incremental single-turn prompt (when continuing a live multi-turn ACP session).
  2. Full labelled replay (`[user]`, `[assistant]`, `[tool call ...]`, `[tool result ...]`) when starting a fresh process.
- [ ] `reuse-context.ts` & `live-processes.ts` — 10-minute idle-timeout registry supporting:
  - Mid-turn tool-call continuation (matching `owner`, `sessionId`, `toolCallIds`, configuration, conversation prefix).
  - Cross-turn multi-turn session reuse (matching `owner`, `sessionId`, configuration including model/effort/systemPrompt/tools/env, and exact prior conversation prefix with one new trailing user message).
- [ ] `launch.ts` — `createAntigravityLauncher()` verifying binary + minimum version before spawning `agy acp --stdio --include-default-customizations=false`.
- [ ] `stream.ts` & `provider.ts` — `createAntigravityStreamFunction()` and `createAntigravityProvider()`.

### C. Server wiring (`src/agent/models.ts`, `src/server/`, `app/api/`)
- [ ] `src/agent/models.ts` — register `createAntigravityProvider(streamAntigravity)` in `piModels()` and resolve dynamic models via `antigravityModel(spec.id)`.
- [ ] `src/server/antigravity-config.ts` — `antigravityEnabled()`, `antigravityAvailable()`.
- [ ] `src/server/antigravity.ts` — `antigravityInstallationStatus()` (version check + catalog refresh) and `antigravityInstallationResponse()` (same-origin guard with `x-learnharness-antigravity: 1`, mirroring `src/server/claude-code.ts`).
- [ ] `app/api/antigravity/route.ts` — `GET` route calling `antigravityInstallationResponse`.
- [ ] `src/server/settings-body.ts` — support `PUT /api/settings/antigravity` (`{ enabled: boolean }`).
- [ ] `src/server/model-catalog.ts` — wire `refreshAntigravityModels()` into `refreshConnectionCatalog()`, add `ANTIGRAVITY_PROVIDER` to `catalogProviders()`, `connectionModel()`, and model listing when `antigravityAvailable()`.
- [ ] `src/server/keys.ts` — return `antigravityAvailable()` in `providerKeyPresent()`.
- [ ] `src/server/pricing.ts` — treat `ANTIGRAVITY_PROVIDER` as unpriced (same as `CLAUDE_CODE_PROVIDER`).
- [ ] `src/server/side-context-budget.ts` — use live `cliContextWindow` for `ANTIGRAVITY_PROVIDER` (same as `CLAUDE_CODE_PROVIDER`).
- [ ] `src/server/chat-handler.ts` — gate background-role admission on `providerKeyPresent` and include saved report history for `ANTIGRAVITY_PROVIDER` (same as `CLAUDE_CODE_PROVIDER`).

### D. Settings & Model Menu UI (`components/`)
- [ ] `components/settings/antigravity-status.tsx` — toggle (off by default), status readout (`Not found`, `Version X.Y.Z · N models`, `Version X.Y.Z · sign in via terminal`, `Version X.Y.Z · update required`, `Version could not be checked`), **Check again** button, and external terminal auth guidance.
- [ ] `components/settings/keys-section.tsx` — render `<AntigravityInstallationStatus />` inside the **External CLI** `SettingsGroup` alongside `<ClaudeCodeInstallationStatus />`.
- [ ] `components/settings/model-menu.tsx` — display `CLI billing` and appropriate tooltip for `ANTIGRAVITY_PROVIDER`.
- [ ] `components/settings-signal.ts` / `components/stats-bar.tsx` — include `"antigravity"` settings signal and any CLI-provider display handling if needed.

### E. Tests & Documentation
- [ ] Offline test suites using synthetic `agy acp` stdio processes and loopback MCP requests:
  - `tests/antigravity-binary.test.ts` (PATH + mise/knownDirs discovery, Windows `.exe` requirement)
  - `tests/antigravity-installation.test.ts` (version parsing, minimum version, timeout, not-signed-in)
  - `tests/antigravity-catalog.test.ts` (`configOptions` + `availableModels` → `Model<Api>[]` + `thinkingLevelMap`)
  - `tests/antigravity-stream.test.ts` (thinking/text streaming, MCP tool admission + hold/resume, denying built-in tools, multi-turn session reuse, transcript replay fallback on edit/retry/expiry, abort/`session/cancel`, usage & `cliContextWindow`)
  - `tests/antigravity-opt-in.test.ts` & `tests/antigravity-status-http.test.ts` (opt-in gating, same-origin guard)
  - `tests/antigravity-status-ui.test.tsx` (Settings UI toggle, status states, Check again)
- [ ] `docs/antigravity.md` — user & maintainer documentation mirroring `docs/claude-code.md`.
