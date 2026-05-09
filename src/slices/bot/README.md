# Bot Slices

Bot-level features that sit between the user-facing channels and the agent core. Bot slices handle message routing, access control, command processing, and operational concerns like usage tracking and sync. They may depend on **setup** and **agent** slices.

## Dependency Rule

```
bot → agent, setup
```

## Sub-modules

| Module | Purpose |
|--------|---------|
| **bot** | Core bot orchestrator. Routes incoming messages through access control, command handling, stop detection, and task dispatch. The entry point for all user interactions. |
| **command** | Command processing and dispatch. Parses bot commands (e.g., `/cancel`, `/status`) and routes them to the appropriate handler. |
| **access** | User access control. Pluggable strategies: open (everyone), allowlist, approval-based, and code-based. Determines whether a user can interact with the bot. |
| **voice** | Voice/audio toggle per user. Manages whether responses should include TTS audio output. |
| **activity** | Task activity tracking and crash recovery. Records the currently running task to a file. On restart, detects interrupted tasks and silently injects a system-role instruction so the agent reviews state and finishes the task autonomously — no user-facing "I restarted" message. |
| **usage** | Daily LLM token usage tracking and reporting. Aggregates input/output tokens per credential, persists daily stats, and reports to an external API on a daily cron. |
| **sync** | S3 sync service. Periodically backs up the agent's working directory (memory, sessions, config) to S3 for durability. |
