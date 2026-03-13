# CleanSlice Runtime

> Agent runtime for the CleanSlice ecosystem. Run any agent defined as files — with a gateway, model adapter, and pluggable tool layer.

## What is this?

An **agent** is just files:

```
agent/
├── SOUL.md        ← who the agent is
├── USER.md        ← who it works with
├── MEMORY.md      ← what it knows
├── HEARTBEAT.md   ← what it monitors
└── skills/        ← what it can do
```

The **runtime** is what brings those files to life. It handles:

- **Gateway** — WebSocket daemon that routes messages between channels (Telegram, Slack, Discord...) and the agent
- **Model adapter** — pluggable LLM backend (Claude, GPT, local models)
- **Tool layer** — exec, browser, HTTP, message, memory and more

The model is **interchangeable**. The agent files stay the same.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Channels                          │
│          Telegram · Slack · Discord · API            │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                   Gateway Daemon                     │
│  WebSocket server · session routing · cron scheduler │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                  Agent Runtime                       │
│                                                      │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────┐  │
│  │  File Layer │   │ Model Adapter│   │  Tools   │  │
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

### Model Adapter

Swap the underlying LLM without changing anything else:

```ts
const runtime = new AgentRuntime({
  model: new ClaudeAdapter({ model: 'claude-sonnet-4-6' }),
  // model: new OpenAIAdapter({ model: 'gpt-4o' }),
  // model: new OllamaAdapter({ model: 'llama3' }),
})
```

## File structure

```
packages/
├── gateway/       ← WebSocket daemon, channel connectors
├── runtime/       ← Core agent loop, tool execution, session management
├── tools/         ← Built-in tool implementations
├── adapters/      ← Model adapters (Claude, OpenAI, Ollama...)
└── memory/        ← JSONL session store, SQLite memory index
```

## Quickstart

```bash
npx create-cleanslice my-agent
cd my-agent
npm run dev
```

Or use the runtime directly:

```ts
import { AgentRuntime } from '@cleanslice/runtime'
import { ClaudeAdapter } from '@cleanslice/adapters'
import { TelegramChannel } from '@cleanslice/gateway'

const runtime = new AgentRuntime({
  agentDir: './agent',
  model: new ClaudeAdapter({ model: 'claude-sonnet-4-6' }),
  channels: [
    new TelegramChannel({ token: process.env.TELEGRAM_TOKEN }),
  ],
})

await runtime.start()
```

## Tech stack

- **TypeScript** — strict, fully typed
- **Bun** — runtime and package manager
- **Zod** — schema validation for tool inputs
- **SQLite** (via `bun:sqlite`) — memory indexing
- **WebSockets** — gateway communication

## Status

🚧 **Early design phase.** The architecture is defined, implementation is in progress.

The reference implementation is [OpenClaw](https://openclaw.ai) — this project is an open, embeddable version of the same runtime.

## License

MIT © [CleanSlice](https://cleanslice.org)
