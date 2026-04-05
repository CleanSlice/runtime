# Agent Slices

Core AI agent capabilities — reasoning, memory, tools, and session management. Agent slices may only depend on **setup** slices.

## Dependency Rule

```
agent → setup (only)
```

> **Known violation:** `agent/tool` imports the `IAgentConfig` type from `runtime/init`. This config type is needed by ToolContext but defined at the runtime level.

## Sub-modules

| Module | Purpose |
|--------|---------|
| **agent** | Agent configuration loading and system prompt construction. Reads `SOUL.md`, admin/owner prompts, and builds the full system message. Gateway persists agent config to disk. |
| **session** | Conversation session management. Stores event history per session with file-based persistence. Includes compaction service that summarizes old messages via LLM to stay within context limits. |
| **memory** | Persistent long-term memory with vector search. Stores markdown entries, supports search and compaction. Uses LLM for memory flush (extracting memories from conversation). |
| **tool** | Tool registry and implementations. Defines the `Tool` interface (name, schema, execute). Concrete tools: browser, exec, file, HTTP, image, memory, message, PDF, secrets, skill, web search, and more. |
| **skill** | Skill management system. Registry for dynamically loaded skills with hot-reload support. Skills extend agent capabilities at runtime. |
| **task** | Background task manager with dispatcher. Tracks running tasks, supports cancellation and message injection. Dispatcher decides whether a new message creates a new task or joins an existing one. |
| **cron** | Cron job scheduling. Registers and executes recurring tasks on configurable schedules. |
| **heartbeat** | Periodic heartbeat trigger. Fires at intervals to keep the agent alive or trigger scheduled behaviors. |
