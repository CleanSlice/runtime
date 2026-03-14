# CleanSlice Runtime

> Agent runtime for the CleanSlice ecosystem. Run any agent defined as files — with a gateway, model adapter, and pluggable tool layer.

## Quickstart

**Prerequisites:** [Bun](https://bun.sh) installed.

```bash
git clone https://github.com/CleanSlice/runtime.git
cd runtime
bun install
```

**1. Create your agent files:**

```bash
mkdir .agent
echo "You are a helpful assistant." > .agent/SOUL.md
echo "Name: Your Name" > .agent/USER.md
```

**2. Create an entrypoint** (`index.ts`):

```ts
import { AgentRuntime } from "./src/runtime"
import { ClaudeRepository } from "./src/slices/llm/data/repositories/claude/claude.repository"

const runtime = new AgentRuntime({
  agentDir: ".agent",
  llm: new ClaudeRepository({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  channels: [
    { type: "telegram", token: process.env.TELEGRAM_TOKEN! },
  ],
})

await runtime.start()
console.log("Agent running.")
```

**3. Run:**

```bash
ANTHROPIC_API_KEY=sk-ant-... TELEGRAM_TOKEN=123:abc bun run index.ts
```

Or with a `.env` file:

```bash
cp .env.example .env   # fill in your keys
bun run index.ts
```

**Environment variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | Claude API key |
| `TELEGRAM_TOKEN` | if using Telegram | Bot token from @BotFather |

**Run tests:**

```bash
bun test
```

---

## What is this?

An **agent** is just files:

```
.agent/
├── SOUL.md        ← who the agent is
├── USER.md        ← who it works with
├── MEMORY.md      ← what it knows
├── HEARTBEAT.md   ← what it monitors
└── skills/        ← what it can do
```

The **runtime** is what brings those files to life. It handles:

- **Channels** — routes messages between Telegram, Slack, Discord... and the agent
- **LLM** — pluggable model backend (Claude, GPT, local models)
- **Tools** — exec, browser, HTTP, message, memory and more
- **Sessions** — append-only JSONL conversation history
- **Cron** — built-in scheduler for recurring tasks

The model is **interchangeable**. The agent files stay the same.

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
│  ┌─────────────┐   ┌──────────────┐   ┌──────────┐  │
│  │  File Layer │   │     LLM      │   │  Tools   │  │
│  │  SOUL.md    │   │              │   │          │  │
│  │  USER.md    │──▶│  Claude      │──▶│  exec    │  │
│  │  MEMORY.md  │   │  GPT         │   │  browser │  │
│  │  skills/    │   │  local LLM   │   │  message │  │
│  └─────────────┘   └──────────────┘   │  memory  │  │
│                                       │  http    │  │
│                                       └──────────┘  │
└─────────────────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                  Session Store                       │
│              JSONL files · memory.sqlite             │
└─────────────────────────────────────────────────────┘
```

## Core concepts

### Sessions

Every conversation is a **session** — a JSONL file where each line is one event:

```jsonl
{"type":"user","text":"hello","ts":1741900800}
{"type":"tool","name":"exec","result":"..."}
{"type":"assistant","text":"done","ts":1741900801}
```

Sessions are append-only, crash-safe, and human-readable.

### Tools

Tools are the agent's hands. Each tool is a TypeScript module:

```ts
interface Tool {
  name: string
  description: string
  schema: JSONSchema
  execute(params: unknown, context: ToolContext): Promise<unknown>
}
```

Built-in tools:

| Tool | What it does |
|------|-------------|
| `exec` | Run shell commands |
| `browser` | Control a headless browser |
| `message` | Send messages to channels |
| `memory` | Read/write agent memory |
| `http` | Make HTTP requests |
| `file` | Read/write files |

### Cron

The runtime has a built-in cron scheduler for recurring agent tasks:

```ts
runtime.cron.add({
  name: 'Morning digest',
  schedule: '0 9 * * *',
  tz: 'Europe/Kiev',
  message: 'Send the morning news digest to the user',
})
```

### LLM

Swap the underlying model without changing anything else:

```ts
const runtime = new AgentRuntime({
  llm: new ClaudeRepository({ apiKey: '...' }),
  // llm: new OpenAIRepository({ apiKey: '...' }),
  // llm: new OllamaRepository({ model: 'llama3' }),
})
```

## Tech stack

- **TypeScript** — strict, fully typed
- **Bun** — runtime and package manager
- **Zod** — schema validation for tool inputs
- **SQLite** (via `bun:sqlite`) — memory indexing

## Status

🚧 **Early design phase.** The architecture is defined, implementation is in progress.

The reference implementation is [OpenClaw](https://openclaw.ai) — this project is an open, embeddable version of the same runtime.

## License

MIT © [CleanSlice](https://cleanslice.org)
