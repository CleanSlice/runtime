# Runtime Slices

Application orchestration — bootstrap and the main execution loop. Runtime slices may depend on **any** other slice group.

## Dependency Rule

```
runtime → agent, bot, setup (all)
```

## Sub-modules

| Module | Purpose |
|--------|---------|
| **init** | Agent initialization and bootstrap. Loads agent config, resolves the working directory, and validates required environment variables. Produces the `IAgentConfig` used by all other modules. |
| **runtime** | Core orchestrator. Manages the full task lifecycle: builds history, assembles system prompt (SOUL + tools + memory + skills), runs the loop, and handles cleanup (session touch, activity clear, memory flush). |
| **loop** | LLM execution engine. Coordinates LLM calls, tool execution, activity tracking, and token usage. Handles continuation logic, error recovery prompts, and loop iteration limits. |
