---
name: runtime-tools
title: Built-in Runtime Tools
description: Reference for every tool baked into the agent runtime. Read this when you need to pick a tool for a task or remember how to call one.
---

# Built-in Runtime Tools

These tools are registered in [`ToolGateway`](src/slices/agent/tool/data/tool.gateway.ts) and are available to **every** agent built on this runtime — no MCP server, no extra plumbing required. Skills from the platform (Ranch templates) add to this list; they never replace it.

When a task fits a tool below, **call it directly**. Do not describe what you would do — do it. If a tool returns an error, surface the error verbatim, do not fabricate success.

---

## Shell & filesystem

| Tool | Use it when |
|---|---|
| `exec` | Execute a shell command and return stdout/stderr. Single-shot, blocks until done. |
| `process_exec` | Run a long-running shell command in the background; poll its output later. Use for things that take >30s or stream output (builds, watchers). |
| `file` | Read or write files on the filesystem. The agent's working dir is `.agent/`. |
| `unzip` | Extract a zip archive to a directory. Trigger when the user sends a `.zip`. |

## Network

| Tool | Use it when |
|---|---|
| `http` | Make an arbitrary HTTP request and return the raw response. Use for API calls, webhooks, REST endpoints. |
| `web_fetch` | Fetch a URL and return cleaned readable text (markdown-style). **Prefer this over `browser` for articles, docs, blog posts** — no JS execution, faster, cheaper. |
| `web_search` | Search the web via Brave Search. Use when you need to discover URLs or facts, not when you already have a URL. |
| `browser` | Fetch a web page and extract its text content. Use for pages that need JS rendering or scraping where `web_fetch` falls short. |
| `browser_screenshot` | Take a screenshot of a website and send it to the user via Telegram. Supports full page. |
| `browser_play` | Full Playwright control with persistent sessions (cookies, localStorage saved between calls and across container restarts). Use for logins, multi-step flows, sites that hate scrapers. |

## Media analysis

| Tool | Use it when |
|---|---|
| `image_analyze` | Analyze an image (URL or local file) using Claude vision. Returns a description / answers a question about it. |
| `pdf_analyze` | Analyze a PDF document from a URL. Extracts text and answers questions about it. |

## Messaging

| Tool | Use it when |
|---|---|
| `telegram_send` | Send a Telegram message to any chat ID. Use to proactively message users (reminders, alerts, follow-ups). |
| `tts` | Convert text to speech and send as a Telegram voice message. Use when the user explicitly asks for audio or when voice is the better channel. |

## Memory

The runtime has two distinct memory surfaces. Treat them as different things.

| Tool | Use it when |
|---|---|
| `memory_search` | Search agent memory + conversation history for relevant information. Use **before guessing** when the user references something they told you before. |
| `memory_save` | Append a note to today's daily memory file (`memory/YYYY-MM-DD.md`). Use **only** for durable facts, significant events, and reusable workflows — not for transient chat state. |

## Scheduling

The agent has its own cron — runs continuously inside the pod.

| Tool | Use it when |
|---|---|
| `cron_list` | List all scheduled cron jobs. |
| `cron_add` | Add a scheduled job. Recurring → use `schedule` (cron expression). One-shot → use `delayMinutes` or `runAt` (ms epoch). **The `message` field must contain real concrete values** — never placeholders like `test@example.com`. |
| `cron_remove` | Remove a cron job by id or name. |
| `cron_disable` | Disable a cron job by id or name (keeps the row but stops execution). |

If you promise the user *"I'll follow up in 10 minutes"* — call `cron_add` in the same response. An unscheduled promise is a lie.

## Secrets (per-user)

User-scoped secrets live in a per-user store. Key format: `service:field` (e.g. `instagram:password`, `upwork:email`).

| Tool | Use it when |
|---|---|
| `secret_set` | Save a secret value for the current user. Use for passwords, tokens, API keys the agent will need to use later. |
| `secret_get` | Retrieve a saved secret. Returns null if not found. |
| `secret_list` | List all secret keys (values are never returned by this tool). |
| `secret_delete` | Delete a saved secret. |

Never echo secret *values* back to the user verbatim. Use them through `browser_play`, `http`, etc.

## Access control (admin-only)

| Tool | Use it when |
|---|---|
| `approve_user` | Approve a pending user by their access code. **Only the bot owner (admin) can use this.** The user is notified automatically. |
| `set_access_strategy` | Switch the bot's access strategy at runtime. Change is persisted to `data/access.json` and survives restarts. Admin-only. |

## Multi-agent

| Tool | Use it when |
|---|---|
| `spawn_agent` | Spawn a Claude Code agent in the background to handle a complex sub-task. The spawned agent reports back when done. Use for tasks that need isolation, long contexts, or parallel work. |

## Skill authoring

| Tool | Use it when |
|---|---|
| `skill_write` | Create or update a skill in the agent's skills directory (`.agent/skills/<name>/SKILL.md`). The skill is immediately reloaded after writing — no restart needed. Use when the user asks you to teach yourself a new workflow. |

---

## Discovery rules

1. **Don't ask "do you have access to X?".** Look at this list, look at your available-tools list, and act. If a tool is listed here it exists.
2. **Don't invent tool names** that aren't in the registered set (no `email_send`, `fetch`, `read_file` — use the canonical names above).
3. **Don't reach for `exec` when there's a specialised tool.** `web_fetch` beats `exec("curl ...")`; `file` beats `exec("cat ...")`. The specialised tools are sandboxed and produce structured output.
4. If a task needs something none of these cover and no MCP server provides it, say so plainly — don't fake it.
