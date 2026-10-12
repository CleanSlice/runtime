# Contract: Agent-facing tools

New or changed tools the model can call. Schemas are Zod in code; shown here as JSON Schema-ish shapes. All results are JSON objects; errors use the runtime convention `{ error: string }`.

## `skill_load` (new, all users)

Pull a skill's full instructions into the conversation for the next `skills.retainTurns` turns.

```json
{ "name": "skill_load", "params": { "name": "string (slug from the catalogue)" } }
```

Result: `{ "name": "ranch", "chars": 5120, "retainedForTurns": 3 }` — the skill body is placed into history as a `summary` event (`[SKILL ranch]…`), not in this result.
Errors: `unknown skill`, `skill unavailable: missing env GITHUB_TOKEN`.

## `tool_describe` (new, all users)

Full description and parameter schema for a tool listed as a one-line stub in the catalogue.

```json
{ "name": "tool_describe", "params": { "name": "string" } }
```

Result: `{ "name": "...", "description": "...", "schema": { ...JSON Schema... }, "effect": "read" | "write", "adminOnly": boolean }`.

## `delegate_task` (new, admin only, blocked inside workers)

Run one or more sub-tasks in fresh contexts with a restricted toolset; resolves when all finish or the budget expires.

```json
{ "name": "delegate_task", "params": {
    "tasks": [ { "goal": "string", "context": "string?", "timeoutMs": "number? (default 300000, max 900000)" } ]
} }
```

Result: `{ "results": [ { "goal", "status": "done|timeout|error|cancelled", "summary": "string ≤ tools.delegate.summaryChars", "truncated": boolean } ] }`.
Worker tools = caller's visible tools minus `delegate_task`, `memory_save`, `telegram_send`, `channel_*`, `skill_write`, `skill_delete`, `secret_set`, `secret_delete`.

## `agent_status` (changed)

Adds three fields to the existing result:

```json
{
  "context": { "total": 31200, "budget": 48000, "sections": [ { "name": "soul", "chars": 9800, "over": false } ], "onDemand": [ { "kind": "skill", "name": "ranch", "chars": 5120 } ] },
  "rules":   { "count": 7, "firedLast24h": [ { "id": "no-secret-store-reads", "times": 2 } ] },
  "learned": { "core": 3, "apply": 5, "suggested": 2, "conflicts": 0 }
}
```

## `Tool.effect` (changed contract for tool authors)

Every built-in tool declares `effect: "read" | "write"`. Unset means `write`. MCP-imported tools are `write` unless the MCP tool annotation `readOnlyHint` is true.

| read | write |
|---|---|
| `web_fetch`, `web_search`, `browser` (fetch), `browser_screenshot`, `image_analyze`, `pdf_analyze`, `memory_search`, `secret_list`, `secret_get`, `cron_list`, `agent_status`, `resource_status`, `session_list`, `skill_load`, `tool_describe`, `file` (read mode), `http` (GET/HEAD) | `exec`, `process_exec`, `file` (write), `unzip`, `http` (other methods), `browser_play`, `telegram_send`, `tts`, `secret_set`, `secret_delete`, `cron_add/remove/disable`, `skill_write`, `skill_delete`, `channel_*`, `memory_save`, `spawn_agent`, `delegate_task` |

## Blocked-call result (changed loop behaviour)

When a `before` rule blocks a call, the tool is not executed and the model receives:

```json
{ "error": "blocked by rule no-secret-store-reads: The secret store is read only through `secret_get`." }
```

The `tool_call` event is still appended; the `tool_result` event carries this object and `blocked: true`.
