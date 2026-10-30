<p align="center">
  <img src="docs/cleanslice-runtime-banner.png" alt="CleanSlice Runtime" />
</p>

# CleanSlice Runtime

> Agent runtime for the CleanSlice ecosystem. Define an agent as files, connect it to channels (Telegram, Slack), and let it use tools — all powered by a pluggable LLM backend.

## Quickstart

**Prerequisites:** [Bun](https://bun.sh) installed.

```bash
git clone https://github.com/CleanSlice/runtime.git
cd runtime
bun install
```

### 1. Initialize the agent

```bash
bun run cli init
```

This copies `.agent.example/` into `.agent/`, creating all required files and an `agent.config.json` with default settings. If `.agent.example/` doesn't exist, a minimal scaffold is created from built-in templates.

### 2. Configure environment

```bash
cp .env.example .env
```

Fill in the required values:

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from @BotFather |
| `TELEGRAM_BOT_NAME` | yes | Bot username (without @) |
| `TELEGRAM_BOT_ADMIN_IDS` | yes | Comma-separated Telegram user IDs |
| `CLAUDE_CODE_OAUTH_TOKEN` | yes | Anthropic OAuth token (supports comma-separated list for rotation) |
| `LLM_MODEL` | no | Model to use (default: `claude-sonnet-4-6`) |
| `LLM_FALLBACK_MODEL` | no | Fallback model (default: `claude-haiku-4-5`) |
| `LLM_AUX_MODEL` | no | Auxiliary model for background work (compaction, memory flush). Defaults to main LLM when unset. |
| `LLM_AUX_PROVIDER` | no | Auxiliary provider — defaults to main provider. |
| `LLM_AUX_API_KEY` | no | Auxiliary API key — defaults to main key. |
| `LLM_AUX_FALLBACK_MODEL` | no | Auxiliary fallback model. |
| `SLACK_BOT_TOKEN` | no | Slack bot token |
| `SLACK_APP_TOKEN` | no | Slack app token |
| `SECRET_PROVIDER` | no | `file` (dev) or `aws` (prod) |
| `CLEANSLICE_AGENT_DIR` | no | Override default `.agent` directory |

### 3. Run

```bash
bun run start          # production
bun run dev            # development (auto-reload on file changes)
```

---

## What is this?

An **agent** is just files:

```
.agent/
├── SOUL.md              ← who the agent is
├── USER.md              ← who it works with
├── MEMORY.md            ← what it remembers
├── HEARTBEAT.md         ← periodic tasks to run
├── agent.config.json    ← runtime configuration
├── skills/              ← pluggable skills
├── data/                ← cron jobs, secrets
├── sessions/            ← conversation history (JSONL)
└── memory/              ← long-term memory storage
```

The **runtime** brings those files to life. It handles channels, LLM calls, tool execution, sessions, cron, and heartbeat — all configured through `agent.config.json`.

---

## Agent configuration

All runtime settings live in `.agent/agent.config.json`. You only need to specify values you want to override — everything has sensible defaults.

```jsonc
{
  // Max LLM iterations per task (tool calls + responses).
  // Increase if the agent hits "Reached max iterations" on complex tasks.
  "maxIterations": 25,

  // Max characters shown in task label previews
  "taskLabelLength": 60,

  "heartbeat": {
    // How often the heartbeat fires (minutes)
    "intervalMin": 30
  },

  "session": {
    // Compact session history after this many events
    "compactionThreshold": 60,
    // Keep this many recent events after compaction
    "recentKeep": 20,
    // Idle sessions over the threshold are compacted by the heartbeat sweep (minutes, 0 = off)
    "idleCompactMin": 30,
    // Size-triggered compaction may interrupt a running task only above this % of contextBudgetChars
    "hardLimitPct": 90
  },

  // Character budget for the always-on system prompt. `/context` shows the actual split.
  "contextBudget": {
    "total": 48000,
    "sections": { "soul": 12000, "tooling": 6000, "skillsCatalog": 3000, "memory": 2200, "dailyNotes": 8000, "alwaysSkills": 12000, "instincts": 2500 }
  },

  "skills": {
    // "model": the agent pulls a skill with `skill_load` when its description fits; "keyword": legacy word overlap
    "selection": "model",
    // Turns a loaded skill stays in the conversation after its last use
    "retainTurns": 3
  },

  // Learned behaviours with confidence — see "Learning" below
  "memory": {
    "instincts": {
      "enabled": true,
      "bands": { "suggested": 0.3, "apply": 0.5, "core": 0.8 },
      "decayDays": 14,
      "maxInjected": 8
    }
  },

  "s3": {
    // Auto-sync interval for S3 backup (seconds)
    "syncIntervalSec": 60
  },

  "tools": {
    "spawnAgent": {
      // Timeout for spawned Claude Code sub-agents (minutes)
      "timeoutMin": 5,
      // Max characters in sub-agent output notification
      "outputLimit": 4000
    },
    "browser": {
      // Max characters returned from browser tool
      "outputLimit": 5000
    },
    "webFetch": {
      // Max characters returned from web_fetch tool
      "maxChars": 8000
    },
    // Tools with a full description always in the prompt; the rest are one-line stubs + `tool_describe`
    "coreCatalogue": ["exec", "file", "http", "web_fetch", "memory_search", "secret_get", "skill_load", "tool_describe"],
    // delegate_task worker budgets
    "delegate": { "timeoutMs": 300000, "maxParallel": 5, "summaryChars": 4000, "allowWrite": false }
  }
}
```

### First-run initialization

On first run, the runtime automatically:

1. Checks if `.agent/` exists and is initialized
2. If not — copies all files from `.agent.example/` (including `agent.config.json`)
3. Creates required subdirectories (`data/`, `sessions/`, `memory/`, `skills/`)

This means you can customize `.agent.example/` in your repo as a template for new deployments.

---

## Agent files

| File | Purpose | Required |
|------|---------|----------|
| `SOUL.md` | Agent personality and behavior rules | yes |
| `USER.md` | Context about the user the agent serves | yes |
| `MEMORY.md` | Long-term memory (agent writes here) | yes |
| `HEARTBEAT.md` | Periodic tasks — agent checks this on every heartbeat | no |
| `agent.config.json` | Runtime configuration (see above) | no (defaults used) |
| `skills/<name>/SKILL.md` | Pluggable skills activated by keywords in user messages | no |

---

## CLI

The CLI provides commands for managing the agent from the terminal.

```bash
bun run cli <command> [options]
```

### Commands

| Command | Description |
|---------|-------------|
| `init` | Scaffold a new `.agent` directory |
| `start` | Start the agent runtime (foreground) |
| `status` | Show agent directory status and health |
| `cron` | Manage scheduled jobs |
| `memory` | View or clear agent memory |
| `sessions` | List or clear conversation sessions |
| `skills` | List or inspect loaded skills |
| `version` | Show version |

### `init`

```bash
bun run cli init [--dir <path>]
```

Creates the `.agent/` directory with all required files. If `.agent.example/` exists in the project root, copies files from there. Otherwise creates from built-in templates.

### `start`

```bash
bun run cli start [--dir <agent-dir>]
```

Starts the runtime in the foreground. Equivalent to `bun run start` but allows overriding the agent directory.

### `status`

```bash
bun run cli status
```

Shows a dashboard of agent health: which files exist, how many sessions/cron jobs are active, which environment variables are set.

### `cron`

```bash
bun run cli cron list
bun run cli cron add --name "Daily digest" --schedule "0 9 * * *" --message "Send morning digest" [--to <chat_id>] [--channel telegram] [--tz Europe/Kiev]
bun run cli cron remove <id>
bun run cli cron enable <id>
bun run cli cron disable <id>
```

Manage cron jobs stored in `.agent/data/cron.json`. Jobs are picked up by the runtime and executed on schedule.

### `memory`

```bash
bun run cli memory show     # print MEMORY.md
bun run cli memory clear    # reset MEMORY.md
```

### `sessions`

```bash
bun run cli sessions list    # list all sessions with message counts
bun run cli sessions clear   # delete all session files
```

### `skills`

```bash
bun run cli skills list           # list loaded skills
bun run cli skills show <name>    # print SKILL.md for a skill
```

### Global options

| Option | Description |
|--------|-------------|
| `--help`, `-h` | Show help for any command |
| `--version`, `-v` | Show version |
| `CLEANSLICE_AGENT_DIR` | Env var to override default `.agent` directory |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Channels                          │
│          Telegram · Slack · Discord · API            │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                  Agent Runtime                       │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │   Init   │  │   LLM    │  │  Tools   │           │
│  │ config   │  │ Claude   │  │ exec     │           │
│  │ bootstrap│  │ GPT      │  │ browser  │           │
│  └──────────┘  │ local    │  │ file     │           │
│                └──────────┘  │ http     │           │
│  ┌──────────┐                │ memory   │           │
│  │  Agent   │  ┌──────────┐  │ web      │           │
│  │ SOUL.md  │  │ Session  │  │ cron     │           │
│  │ USER.md  │  │ JSONL    │  │ image    │           │
│  │ MEMORY   │  │ compact  │  │ secret   │           │
│  │ skills/  │  └──────────┘  │ message  │           │
│  └──────────┘                │ spawn    │           │
│                              └──────────┘           │
└─────────────────────────────────────────────────────┘
```

### Slices

The runtime is organized into vertical slices following CleanSlice architecture:

| Slice | Purpose |
|-------|---------|
| `init` | First-run bootstrap and `agent.config.json` loading |
| `agent` | Loads agent files (SOUL, USER, MEMORY) and builds system prompt |
| `session` | Append-only JSONL conversation history with auto-compaction |
| `llm` | Pluggable LLM adapters (Claude, OpenClaw, etc.) |
| `channel` | Message routing (Telegram, Slack) |
| `tool` | Tool registry and execution |
| `task` | Task manager with dispatcher (parallel tasks, inbox) |
| `memory` | Agent long-term memory persistence |
| `skill` | Dynamic skill loading from `.agent/skills/` |
| `cron` | Scheduled job execution |
| `heartbeat` | Periodic health checks |
| `access` | User authorization and invite codes |
| `voice` | Text-to-speech voice mode |
| `sync` | S3 backup and sync |

### Tools

Built-in tools available to the agent:

| Tool | Description |
|------|-------------|
| `exec` | Run shell commands |
| `process` | Run long-running processes |
| `spawn_agent` | Spawn a Claude Code sub-agent for complex tasks |
| `browser` | Fetch web pages (headless Chromium) |
| `playwright` | Full browser automation (click, fill, screenshot) |
| `screenshot` | Take page screenshots with AI analysis |
| `web_search` | Search the web |
| `web_fetch` | Fetch and extract clean text from URLs |
| `file` | Read and write files |
| `unzip` | Extract archives |
| `http` | Make HTTP requests |
| `memory_search` | Search agent memory |
| `image_analyze` | Analyze images with Claude Vision |
| `pdf_analyze` | Extract and analyze PDF content |
| `telegram_send` | Send messages to Telegram chats |
| `tts` | Text-to-speech via Telegram voice messages |
| `cron_*` | Manage cron jobs (list, add, remove, disable) |
| `invite` | Manage user invite codes |
| `secret_*` | Manage encrypted user secrets (set, get, list, delete) |

### Context budget

The always-on prompt is accounted per section against `contextBudget`; `/context` shows the last turn's split and what was pulled in on demand, `agent_status` carries the same under `context`. The `## Rules` section of `SOUL.md` is never truncated to fit `memory.limits.soul` — reference material goes first, and an overflow is logged at start-up naming the file. Skills enter a turn when the model calls `skill_load` (their catalogue description says when), stay for `skills.retainTurns` turns, and ride in the history rather than the system prompt so the cached prefix stays stable; a skill whose `requires.env` / `requires.bins` are unmet is listed as `(unavailable: …)`. A skill with `metadata.always: true` is the exception: its whole body rides in every system prompt, so none of the bundled skills sets it (CLEAN-199) and an agent-level skill should only when it is needed on every turn. Tools outside `tools.coreCatalogue` appear as one-line stubs and `tool_describe` returns the full description and parameters.

### Delegation

`delegate_task` (admin) runs sub-tasks in isolated workers inside the runtime: each gets a fresh history with the goal and the context the parent passed, the parent's identity, and the parent's tools minus everything that leaves the conversation (`telegram_send`, `tts`, `memory_save`, `skill_*`, `secret_set/delete`, `cron_*`, `channel_*`, `spawn_agent`, and `delegate_task` itself). Independent sub-tasks run concurrently up to `tools.delegate.maxParallel`; each has a time budget and returns one summary cut to `summaryChars`. The parent owns collection: a turn cannot end while its workers run — the loop waits up to the budget, cancels the rest, and hands the model a note listing what finished and what was cancelled so it reports facts rather than "waiting". `/tasks` shows workers indented under their parent. `spawn_agent` remains the way to run an external Claude Code coding agent.

### Learning

The agent learns behaviours, not just notes. Every `memory.review.everyTurns` turns (and on `/clear`) the auxiliary model reviews the conversation and reports, in JSON, durable facts for `MEMORY.md` plus **instincts** — one trigger, one action, with evidence pointing at the exchange. Each instinct lives as one markdown file in `.agent/memory/instincts/` and carries a confidence:

| Source | Starts at | Band |
|--------|-----------|------|
| explicit admin rule ("never …", "always …") | 0.9, pinned | core — rendered as a standing rule |
| correction ("shorter next time") | 0.6 | apply — shapes the agent's actions |
| resolved error, repeated workflow | 0.5 | apply |

Confidence moves with experience: +0.05 when the review sees the behaviour applied without complaint, −0.2 when the person pushes back, −0.05 per `decayDays` without reinforcement (pinned ones never decay). Bands (`memory.instincts.bands`): below `suggested` a behaviour is hidden, from `suggested` it is listed for the operator only, from `apply` it is rendered into the prompt, from `core` it reads as a rule. A contradicting pair keeps the higher confidence in the prompt and surfaces the conflict.

`/learned` lists everything by band with evidence counts; `/learned show <id>` the evidence; `pin` / `unpin`, `prune [<id>]`, `promote <id…>` (writes `skills/learned-<slug>/SKILL.md` for review), `export`. `agent_status.learned` carries the counts. `bun run eval tests/evals/corrections.jsonl` checks that one correction holds on the next matching messages.

### Bot commands

Users can interact with the bot via Telegram/Slack commands:

| Command | Description |
|---------|-------------|
| `/start` | Start the bot / activate via invite link |
| `/help` | Show available commands |
| `/status` | Agent status and model info |
| `/clear` | Reset current conversation session |
| `/memory` | What the agent remembers about you |
| `/tasks` | List active tasks |
| `/cancel <id>` | Cancel a running task |
| `/voice` | Toggle voice mode (TTS) |
| `/skills` | List loaded skills |
| `/skills reload` | Reload skills from disk (admin only) |
| `/context` | System prompt size per section vs budget, and what was loaded on demand last turn (admin only) |
| `/learned` | What the agent has learned, with confidence; `show`, `pin`, `unpin`, `prune`, `promote`, `export` (admin only) |
| `/compact` | Archive this conversation's older history now (admin only) |

---

## Sessions

**When compaction runs.** History is archived at task boundaries (after a turn ends), on the heartbeat's idle sweep (`session.idleCompactMin`), or on `/compact`. While a task of the session is still running, size-triggered compaction waits — the archive would lose the paths and partial results the task is using — unless the history passes `session.hardLimitPct` of `contextBudgetChars`, when it proceeds as `hard-limit`. Every archive summary records its `reason` and an in-flight note (goal, last steps, pending work); `agent_status.lastCompaction` shows the latest.

Every conversation is a **session** — a JSONL file where each line is one event:

```jsonl
{"type":"user","text":"hello","ts":1741900800}
{"type":"tool_call","name":"exec","params":{"command":"ls"}}
{"type":"tool_result","result":"..."}
{"type":"assistant","text":"done","ts":1741900801}
```

Sessions are append-only and crash-safe. When a session exceeds `session.compactionThreshold` events, older events are summarized by the LLM into an archived context block, keeping only the most recent `session.recentKeep` events.

---

## Tech stack

- **TypeScript** — strict, fully typed
- **Bun** — runtime and package manager
- **Zod** — schema validation for tool inputs
- **Playwright** — browser automation
- **Anthropic SDK** — Claude API integration

## License

MIT
