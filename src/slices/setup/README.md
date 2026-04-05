# Setup Slices

Shared infrastructure and foundational abstractions. Setup slices are **independent** — they must not import from `agent/`, `bot/`, or `runtime/`.

## Dependency Rule

```
setup ← does not depend on anything outside setup
```

> **Known violation:** `setup/llm` imports the `Tool` type from `agent/tool` to serialize tools for LLM API calls. This is a pragmatic trade-off — the Tool interface is the contract between the agent and the LLM layer.

## Sub-modules

| Module | Purpose |
|--------|---------|
| **channel** | Message transport abstraction (Telegram, Slack). Defines `Message`, `ChannelServer`, and `ChannelConfig` types. Concrete adapters live in `data/`. |
| **event** | Core event type definitions (`Event`, `EventType`). Shared by all layers — LLM, session, loop, intake. In-memory event store with append/read by session. |
| **llm** | Language model abstraction. Gateway interface with concrete implementations for Claude API, Claude CLI, and OpenClaw. Handles streaming, tool formatting, and token usage reporting. |
| **secret** | Encrypted credential storage. Gateway pattern with file-based and AWS Secrets Manager backends. Provides get/set/list/delete for API keys and tokens. |
