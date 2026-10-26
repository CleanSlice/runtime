# Data Model: Harness Principles for the Runtime Agent

**Feature**: [spec.md](spec.md) · **Research**: [research.md](research.md)

All persisted entities are files inside the agent directory, consistent with "an agent is just files". Types below are the TypeScript shapes the domain layer owns; file formats follow.

---

## 1. Rule (guardrail)

Slice: `agent/guard`. Files: `.agent/rules/<id>.md` (agent) and bundled baseline.

```ts
type RuleEvent  = "before" | "after"
type RuleAction = "block" | "redact" | "record"

interface IRuleMatch {
  tool: string                 // glob on tool name: "exec", "file", "mcp__*", "*"
  arg?: { path: string; pattern: string }   // JSON path into params + regex (before)
  result?: string              // regex over serialized result (after)
}

interface IRule {
  id: string                   // slug, unique across baseline + agent
  event: RuleEvent
  match: IRuleMatch
  action: RuleAction
  enabled: boolean             // default true
  protected: boolean           // baseline only; agent rules cannot override
  source: "baseline" | "agent"
  reason: string               // markdown body — shown to the agent when it fires
}
```

**Validation**: `id` `^[a-z0-9-]{2,64}$`; `match.tool` non-empty; `arg` only with `event: before`; `result` only with `event: after`; an agent rule whose `id` collides with a `protected` baseline rule is rejected at load (fail-closed, R5).

**Composition**: for one call, outcome = strictest action among matching rules: `block` > `redact` > `record`.

**File format**:

```markdown
---
id: no-secret-store-reads
event: before
match: { tool: "exec|process_exec|file|unzip", arg: { path: "$", pattern: "data/secrets" } }
action: block
protected: true
---
The secret store is read only through `secret_get`.
```

## 2. Tool-call record

Slice: `agent/guard`. File: `.agent/data/toolcalls.jsonl`, append-only, rotated daily by size like `usage.json`.

```ts
interface IToolCallRecord {
  ts: number
  sessionId: string
  turnId: string
  tool: string
  outcome: "ok" | "error" | "blocked" | "timeout"
  durationMs: number
  paramsChars: number
  resultChars: number
  rulesFired: string[]         // rule ids
  redacted: boolean
  effect: "read" | "write"     // from Tool.effect (R12)
}
```

Used as evidence by instincts (`evidence[].ref = "toolcall:<ts>:<turnId>"`) and by `/rules` for "fired recently".

## 3. Learned behaviour (instinct)

Slice: `agent/instinct`. Files: `.agent/memory/instincts/<id>.md`.

```ts
type InstinctSource = "correction" | "error-resolution" | "repetition" | "explicit-rule"
type InstinctBand   = "suggested" | "apply" | "core"

interface IEvidence { ref: string; ts: number; note?: string }   // ref: "session:<id>#<eventId>" | "toolcall:<ts>:<turnId>"

interface IInstinct {
  id: string
  trigger: string              // one situation, one sentence
  action: string               // markdown body "## Action"
  confidence: number           // 0.1 .. 0.95
  scope: "agent" | "shared"
  source: InstinctSource
  pinned: boolean
  evidence: IEvidence[]
  created: number
  reinforced: number           // last reinforcement ts
  promotedTo?: string          // skill name after /learned promote
}
```

**Bands** (configurable `memory.instincts.bands`): `suggested` [0.3, 0.5), `apply` [0.5, 0.8), `core` [0.8, 1]. Below 0.3 → not injected, listed as prune candidates.

**State transitions**:

```
create(correction)        → confidence 0.6  (apply)
create(error-resolution)  → 0.5             (apply)
create(repetition)        → 0.5             (apply)
create(explicit-rule)     → 0.9, pinned     (core)
reinforce()               → +0.05, cap 0.95, reinforced = now
correct()                 → −0.2, floor 0.1
decay(now)                → −0.05 per decayDays since reinforced, unless pinned
pin()/unpin()             → pinned flag; pinned never decays, never auto-pruned
promote(skill)            → promotedTo set; body stays as pointer
prune()                   → file deleted (operator action or confidence < 0.3 for > 2×decayDays)
```

**Conflict**: two instincts with triggers the review pass marks as contradictory → both kept; the lower one gets `conflictsWith: <id>` in frontmatter and is excluded from injection; `/learned` lists the pair.

**Invariant** (FR-016): instincts are rendered into the prompt only; they never enter `GuardService`. A rule always wins by construction.

## 4. Skill (extended)

Slice: `agent/skill`. Existing `SkillMetadata` gains nothing new; the load state is per session:

```ts
interface ILoadedSkill { name: string; loadedAtTurn: number }   // retained skills.retainTurns turns
```

`SkillRequires` (`bins`, `env`) already exists; the catalogue entry gains a `(unavailable: missing GITHUB_TOKEN)` suffix when unmet.

## 5. Context budget

Slice: `agent/agent` (computed), `runtime/init` (config).

```ts
interface IContextBudget {                      // agent.config.json → contextBudget (chars)
  total: number                                 // default 48_000
  sections: { soul: number; tooling: number; skillsCatalog: number; memory: number; dailyNotes: number; alwaysSkills: number; instincts: number }
}

interface IPromptBreakdown {                    // returned by buildSystemPrompt, kept per session
  total: number
  sections: Array<{ name: string; chars: number; over: boolean }>
  onDemand: Array<{ kind: "skill" | "tool"; name: string; chars: number }>   // this turn
}
```

**Validation**: `soul` section — the `## Rules` heading and everything under it is exempt from top-truncation; the memory gateway truncates other headings first and reports `over: true` if rules alone exceed the cap.

## 6. Compaction checkpoint

Slice: `agent/session`. Extends the existing `summary` event:

```ts
interface ISummaryData {
  text: string
  reason?: "boundary" | "idle" | "hard-limit" | "operator"
  inFlight?: { goal: string; done: string[]; pending: string[]; openQuestions: string[] }
}
```

Session-level runtime state (not persisted): `inFlight: Set<sessionId>` maintained by `TaskManager`.

## 7. Tool effect

Slice: `agent/tool`. `Tool` gains:

```ts
effect?: "read" | "write"     // default "write"; verification runs when any write tool ran this turn
```

Per-turn loop state: `mutatingCalls: IToolCallRecord[]`.

## 8. Verification result

Slice: `runtime/loop`.

```ts
interface IVerification {
  ok: boolean
  reply?: string               // rewritten factual reply when !ok
  elapsedMs: number
  timedOut: boolean
}
```

## 9. Delegated worker

Slice: `agent/task`.

```ts
interface IDelegateRequest { goal: string; context?: string; timeoutMs?: number }
interface IDelegateResult  { goal: string; status: "done" | "timeout" | "error" | "cancelled"; summary: string; truncated: boolean }
```

Worker `Task` has `internal: true`, `parentTaskId`, its own `taskSessionId`, and tools filtered by `DELEGATE_BLOCKED`. Loop invariant: a parent turn's `continueLoop` cannot become `false` while any child with `parentTaskId === task.id` is `running`.

---

## Relationships

```
Rule ──fires──▶ ToolCallRecord ◀──evidence── Instinct ──promotedTo──▶ Skill
                                     │
ContextBudget ◀──reports── PromptBreakdown ◀── (Rules in SOUL, Instincts, Skills, Tools)
Task ──inFlight──▶ Session ──summary(reason, inFlight)──▶ CompactionCheckpoint
Tool.effect ──▶ mutatingCalls ──▶ Verification
Task(parent) ──▶ Task(child, DELEGATE_BLOCKED) ──▶ DelegateResult
```
