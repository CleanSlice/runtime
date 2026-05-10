# CleanSlice Runtime — Improvement Plan

Roadmap of features ported / inspired from the **Hermes Agent** (Nous Research,
[github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent),
local checkout: `../../opensource/hermes`).

Each item lists: **value · cost · Hermes source · CleanSlice integration site**.
Items are grouped by phase; intra-phase order is the recommended implementation order.

---

## Phase 1 — High value, low cost

### 1. Auxiliary LLM client (in progress)

A second LLM gateway for background work (compaction, summarization,
session-search results, future curator/insights). Keeps the main session's
prompt cache hot and lets us route cheap tasks to a smaller/cheaper model.

- **Hermes**: `agent/auxiliary_client.py` + `agent/curator_backup.py` (fork pattern)
- **CleanSlice integration**:
  - `LlmConfig` in `src/slices/setup/llm/domain/llm.types.ts` — already a discriminated union, reuse as-is
  - `LlmModule` in `src/slices/setup/llm/llm.module.ts` — add optional `auxConfig` constructor arg, second internal `LlmService`, `getAuxGateway()` / `auxComplete()` methods
  - `RuntimeConfig` in `src/slices/runtime/runtime/runtime.module.ts` — accept `llmAuxiliary?: LlmConfig`
  - `src/index.ts` — read `LLM_AUX_PROVIDER` / `LLM_AUX_MODEL` / `LLM_AUX_API_KEY` env vars; if absent, default aux to main provider with `claude-haiku-4-5`
  - `src/slices/agent/memory/domain/memory.service.ts:97` — switch `llm.getGateway()` → `llm.getAuxGateway()` for compaction
  - `.env.example` + `README.md` — document the new env vars

### 2. Cross-session FTS5 search

SQLite FTS5 index over JSONL session events + aux-LLM summarization of top-N
matches. Lets the agent recall things from past conversations without bloating
the active context.

- **Hermes**: `tools/session_search_tool.py`, FTS5 schema in `hermes_state.py`
- **CleanSlice integration**:
  - New repo `src/slices/agent/session/data/repositories/fts/sqlite-fts.repository.ts` (use Bun's native `bun:sqlite`)
  - Indexer hook in `SessionService` — every appended event also written to FTS
  - New tool `src/slices/agent/tool/data/repositories/session_search/session_search.repository.ts` — calls aux LLM (depends on #1) to summarize matches

### 3. Provider plugin pattern

Today `LlmGateway` switch-cases over 5 providers in `src/slices/setup/llm/data/llm.gateway.ts`. Move to discovery: each provider lives in its own folder under `src/slices/setup/llm/data/repositories/` (already true) but is registered via a manifest, and *user-supplied* providers can be loaded from `.agent/providers/<name>/` without rebuilding the runtime.

- **Hermes**: `providers/base.py` (`ProviderProfile` ABC) + `plugins/model-providers/<name>/`
- **CleanSlice integration**:
  - New `IProviderProfile` abstract class in `src/slices/setup/llm/domain/provider.profile.ts`
  - Built-in profiles colocated with each repository (e.g. `claude.profile.ts` next to `claude.repository.ts`)
  - `LlmGateway` builds repository from profile registry instead of hard-coded `switch`
  - Optional discovery of `.agent/providers/<name>/profile.ts` at boot

### 4. Curator (background skills maintenance)

An idle-triggered fork that reviews `.agent/skills/`, archives stale skills,
consolidates duplicates, never deletes. Uses aux model (depends on #1).

- **Hermes**: `agent/curator.py` — strict invariants: only agent-created, never delete, pinned bypass
- **CleanSlice integration**:
  - New slice `src/slices/agent/curator/` with `domain/`, `data/`, `curator.module.ts`
  - Triggered from `HeartbeatModule` when idle ≥ N hours and last run ≥ M hours
  - Persists state in `.agent/data/curator.json`

### 5. Insights / cost analytics

`/insights [--days N]` slash command — token usage, cost estimate, tool usage
patterns, model breakdown, activity trends.

- **Hermes**: `agent/insights.py`, `agent/usage_pricing.py`
- **CleanSlice integration**:
  - Extend `src/slices/bot/usage/` with `insights.service.ts` + `pricing.service.ts`
  - Pricing table for Claude / DeepSeek / Mistral / OpenRouter
  - New slash `/insights` in `src/slices/bot/command/domain/command.service.ts`

---

## Phase 2 — Medium value, medium cost

### 6. Subagent delegation with isolated context + restricted toolset

Native in-runtime `delegate_task` (vs current `spawn_agent` which shells out to
Claude Code). Children get fresh conversation, own `task_id`, restricted
toolset (no nested delegate / memory writes / send_message). Parent only sees
the summary.

- **Hermes**: `tools/delegate_tool.py`, `DELEGATE_BLOCKED_TOOLS` frozenset
- **CleanSlice integration**:
  - Extend `src/slices/agent/task/` with `delegate.service.ts`
  - New tool `src/slices/agent/tool/data/repositories/delegate/delegate.repository.ts`
  - Toolset filter respecting blocked-tools list from `agent.config.json`

### 7. Memory backend plugins

Today `src/slices/agent/memory/data/repositories/` has `file/` and `sqlite/`.
Lift to `IMemoryProvider` + plugin discovery so users can wire mem0 / honcho /
supermemory without runtime changes.

- **Hermes**: `agent/memory_provider.py` ABC + `plugins/memory/{honcho,mem0,supermemory,...}`

### 8. Mirror — cross-platform session continuity

Same `userId` continues the same session whether they message via Telegram,
Slack, or Bridle.

- **Hermes**: `gateway/mirror.py`, `gateway/session_context.py`
- **CleanSlice integration**:
  - New `src/slices/agent/session/domain/session-router.service.ts` — `userId` → `sessionId` (independent of channel)
  - Update `getOrCreate(channel, userId)` callers in `runtime.module.ts`

### 9. Additional channels: Discord + generic Webhook

- **Hermes**: `gateway/platforms/discord.py`, `gateway/platforms/webhook.py`
- **CleanSlice integration**:
  - `src/slices/setup/channel/data/repositories/discord/`
  - `src/slices/setup/channel/data/repositories/webhook/`

### 10. Safety pipeline (path / URL / redaction)

- **Hermes**: `tools/path_security.py`, `tools/url_safety.py`, `agent/redact.py`, `tools/approval.py`
- **CleanSlice integration**:
  - New setup slice `src/slices/setup/safety/` with services for path-allow, URL-allow, log-redact
  - Inject into `ToolGateway` execution path (pre-call validation)

### 11. Sandbox terminal backends (Docker / SSH / Modal)

`exec` / `process` repositories currently shell out locally. Make backend pluggable so prod agents can run tools inside an ephemeral container.

- **Hermes**: `tools/terminal_tool.py` + Modal/Daytona/Vercel/Docker/SSH backends

### 12. STT (voice memo transcription)

Currently `src/slices/bot/voice/` only does TTS. Add Whisper-based STT for inbound voice.

- **Hermes**: `tools/transcription_tools.py`, faster-whisper

### 13. Image generation tool

- **Hermes**: `tools/image_generation_tool.py` + `agent/image_routing.py`
- **CleanSlice integration**: new `src/slices/agent/tool/data/repositories/image/imagegen.repository.ts`

---

## Phase 3 — Niche

### 14. MCP OAuth manager
`tools/mcp_oauth_manager.py` — token storage + refresh for MCP servers requiring OAuth.

### 15. Shell / lifecycle hooks
`agent/shell_hooks.py` — pre/post tool-call event hooks.

### 16. Mixture-of-agents tool
`tools/mixture_of_agents_tool.py` — ensemble responses for hard tasks.

### 17. Computer use
`tools/computer_use/` — desktop control on macOS via cua-driver.

### 18. ACP adapter
`acp_adapter/` — make CleanSlice runtime an ACP server for Zed / other coding agents.

### 19. Trajectory recording / RL
`batch_runner.py`, `trajectory_compressor.py` — only if dataset/training plans materialize.

---

## Status

| # | Item | Status |
|---|---|---|
| 1 | Auxiliary LLM client | shipped — v0.4.0 |
| 1b | Per-token rate-limit pool (Phase A of credential-pool feature) | shipped — v0.5.0 |
| 1c | Usage reporter to ranch (Phase C of credential-pool feature) | shipped — v0.6.0 |
| 2 | Cross-session FTS5 search | planned |
| 3 | Provider plugin pattern | planned |
| 4 | Curator | planned |
| 5 | Insights / cost analytics | planned |
| 6+ | (Phase 2 / 3) | backlog |
