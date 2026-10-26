# Contract: Operator commands, config, and file formats

## Chat commands (`CommandService`, admin-only unless noted)

| Command | Behaviour |
|---|---|
| `/rules` | Lists rules: id, event, action, source (baseline/agent), enabled, fired-last-24h count. |
| `/rules reload` | Re-reads `.agent/rules/`; on a malformed file replies with file + reason and keeps the previous set. |
| `/context` | Last prompt breakdown for this session: per-section chars vs budget, `over` markers, on-demand loads of the last turn. |
| `/learned` | Lists instincts grouped by band: `id · confidence · trigger → action · evidence n · reinforced <date>`; conflicts listed last. |
| `/learned show <id>` | Full instinct with evidence refs. |
| `/learned pin <id>` / `unpin <id>` | Toggle pinned. |
| `/learned prune [<id>]` | Without id: deletes every instinct below 0.3 for more than 2×decayDays, replies with count. With id: deletes that one. |
| `/learned promote <id> [<id>…]` | Writes `.agent/skills/learned-<slug>/SKILL.md` from the instincts (description = joined triggers), marks them `promotedTo`, reloads skills. |
| `/learned export` | Sends `instincts.md` (all files concatenated) as an attachment. Raw observations are never exported. |
| `/compact` | Manual compaction, reason `operator`; replies with before/after event counts. |
| `/help` | Gains the lines above (admin section). |

Non-admin users see `/rules`, `/context`, `/learned` as "admin only".

## `agent.config.json` additions (all optional, defaults shown)

```jsonc
{
  "contextBudget": {
    "total": 48000,
    "sections": { "soul": 12000, "tooling": 6000, "skillsCatalog": 3000, "memory": 2200, "dailyNotes": 8000, "alwaysSkills": 12000, "instincts": 2500 }
  },
  "skills": {
    "selection": "model",        // "model" | "keyword" (fallback, removed next release)
    "retainTurns": 3
  },
  "tools": {
    "coreCatalogue": ["exec", "file", "http", "web_fetch", "memory_search", "secret_get", "skill_load", "tool_describe"],
    "delegate": { "timeoutMs": 300000, "maxParallel": 5, "summaryChars": 4000 }
  },
  "guard": {
    "observerTimeoutMs": 2000,
    "recordFile": "data/toolcalls.jsonl",
    "recordMaxBytes": 10485760
  },
  "memory": {
    "instincts": {
      "enabled": true,
      "bands": { "suggested": 0.3, "apply": 0.5, "core": 0.8 },
      "start": { "correction": 0.6, "errorResolution": 0.5, "repetition": 0.5, "explicitRule": 0.9 },
      "reinforce": 0.05, "correct": 0.2, "decay": 0.05, "decayDays": 14,
      "maxInjected": 8
    }
  },
  "session": {
    "idleCompactMin": 30,
    "hardLimitPct": 90          // size-triggered compaction may interrupt a task only above this % of contextBudgetChars
  },
  "verification": {
    "enabled": true,
    "timeoutMs": 8000
  }
}
```

## Rule file `.agent/rules/<id>.md`

```markdown
---
id: no-prod-deletes            # ^[a-z0-9-]{2,64}$
event: before                  # before | after
match:
  tool: "http"                 # glob; "*" for all
  arg: { path: "$.method", pattern: "^DELETE$" }   # before only
  # result: "regex"            # after only
action: block                  # block | redact | record
enabled: true
---
Deleting through the API is done from the console, not by the agent.
```

Baseline rules ship in the runtime image under `src/slices/agent/guard/data/baseline/` with `protected: true`:

| id | event | match | action |
|---|---|---|---|
| `no-secret-store-reads` | before | `exec|process_exec|file|unzip` · `$` ~ `data/secrets` | block |
| `no-env-reads` | before | `exec|process_exec|file` · `$` ~ `(^|/)\.env(\.|$)` | block |
| `redact-credentials` | after | `*` · result ~ credential patterns from `setup/logger/redact.ts` | redact |
| `cap-result-size` | after | `*` | redact (truncate to `maxToolOutputChars`, already implemented — moved under the rule) |
| `record-all` | after | `*` | record |

## Instinct file `.agent/memory/instincts/<id>.md`

```markdown
---
id: confirm-before-restart
trigger: "Operator asks to restart an agent"
confidence: 0.75
scope: agent
source: correction
pinned: false
evidence:
  - { ref: "session:bridle:admin#8f2c…", ts: 1791234567000, note: "operator: don't restart without asking" }
created: 1791234567000
reinforced: 1791834567000
---
## Action
Ask for confirmation naming the agent before calling the restart endpoint.
```

## Session `summary` event (extended)

```json
{ "type": "summary", "data": {
    "text": "[ARCHIVED CONTEXT …]",
    "reason": "boundary",
    "inFlight": { "goal": "…", "done": ["…"], "pending": ["…"], "openQuestions": [] }
} }
```

## Tool-call record line `.agent/data/toolcalls.jsonl`

```json
{"ts":1791234567000,"sessionId":"bridle:admin","turnId":"…","tool":"exec","outcome":"blocked","durationMs":0,"paramsChars":84,"resultChars":112,"rulesFired":["no-secret-store-reads"],"redacted":false,"effect":"write"}
```
