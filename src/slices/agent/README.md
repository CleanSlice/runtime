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
| **session** | Conversation session management. Stores event history per session with file-based persistence. Includes compaction service that summarizes old messages via LLM to stay within context limits — at task boundaries, on the idle sweep or on request, deferring while a task is in flight until the hard limit; every archive records its reason and an in-flight note. |
| **memory** | Persistent long-term memory with vector search. Stores markdown entries, supports search and compaction. Uses LLM for memory flush (extracting memories from conversation). |
| **tool** | Tool registry and implementations. Defines the `Tool` interface (name, schema, execute). Concrete tools: browser, exec, file, HTTP, image, memory, message, PDF, secrets, skill, web search, and more. |
| **skill** | Skill management system. Registry for dynamically loaded skills with hot-reload support. Skills enter a turn when the model calls `skill_load` (their body rides in the history, not the system prompt) and stay for a few turns; `requires.env` / `requires.bins` gate availability. |
| **task** | Background task manager. Tracks running tasks, supports cancellation and message injection into a task's inbox. Knows which sessions have a task in flight and which tasks are delegated workers of another (`parentTaskId`). |
| **guard** | Guardrails around every tool call (CLEAN-150). Rules as markdown files (`.agent/rules/*.md`) plus a protected platform baseline: block / redact / record, composed strictest-first; fail-closed loading; the tool-call record (`data/toolcalls.jsonl`). |
| **instinct** | Learned behaviours with confidence (CLEAN-150). One markdown file per behaviour; bands suggested / apply / core; reinforce, correct, decay, pin, prune, promote to a skill; rendered into the prompt for admin sessions. Fed by the memory review. |
| **router** | LLM-backed message router. Given the active running tasks, classifies an incoming message as a new topic, continuation of an existing task, or ambiguous (in which case it asks the user to choose). |
| **cron** | Cron job scheduling. Registers and executes recurring tasks on configurable schedules. |
| **heartbeat** | Periodic heartbeat trigger. Fires at intervals to keep the agent alive or trigger scheduled behaviors. |
