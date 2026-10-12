# Research: Harness Principles for the Runtime Agent

**Feature**: [spec.md](spec.md) · **Date**: 2026-10-12

Each entry resolves an unknown from the Technical Context or records a design decision with the alternatives that were weighed. Decisions reference the exact runtime code they build on so the plan stays grounded.

---

## R1. Where guardrails hook into tool execution

**Decision**: One interception point in `LoopService.executeToolCalls` (`src/slices/runtime/loop/domain/loop.service.ts:320-423`), wrapped as a new `agent/guard` slice whose service exposes `before(call, ctx)` → `{ allow | block(reason) | rewrite(params) }` and `after(call, result, ctx)` → `{ result' , redacted }`. `ToolService.execute` (`tool.service.ts:18`) is *not* the hook point: MCP-imported tools and the loop's timeout/admin-only checks already bypass it, so hooking there would miss calls.

**Rationale**: `executeToolCalls` is the single place where every tool call — built-in, MCP, admin-gated — passes with full `ToolContext`, where `tool_call` / `tool_result` events are appended, and where `capPayload` already applies the size cap (CLEAN-124). Guardrails compose naturally with the existing `adminOnly` check (which is itself a hard-coded block rule) and the thinking-step emission.

**Alternatives considered**:
- Wrapping each `Tool.execute` at registration in `ToolGateway` — misses the loop's timeout race and would need a second wrap for MCP tools merged later.
- A decorator on `ILlmGateway` that filters `toolCalls` in the response — runs before `tool_call` is persisted, so blocked attempts would leave no record.

## R2. Rule declaration format

**Decision**: Rules are markdown files with YAML frontmatter under `.agent/rules/*.md` (agent-level) and `src/slices/agent/guard/data/baseline/*.md` (platform baseline, bundled), parsed with the `gray-matter` dependency the skill loader already uses. Frontmatter carries `event` (`before` | `after`), `match` (tool name glob, optional argument path + regex, optional result regex), `action` (`block` | `redact` | `record`), `enabled`; the body is the operator-facing reason shown when the rule fires. A `protected: true` baseline rule cannot be overridden by an agent rule of the same `id`.

**Rationale**: Matches "an agent is just files" and the existing SKILL.md convention (frontmatter + prose), so operators learn one format. Readable in chat (`/rules`), diffable, syncable via the same S3/template path as skills. ECC's `hooks.json` is JSON with shell commands — shell-outs are the wrong primitive for a container agent (no shell per call, latency, Windows parity), so the action vocabulary is declarative.

**Alternatives considered**:
- JSON in `agent.config.json` — no room for the human reason text, and mixes rules with runtime tuning.
- Executable hook scripts (ECC-style) — maximal power, but every call would spawn a process; deferred to a later `script` action once the declarative set proves insufficient.

## R3. Credential redaction in results and outgoing messages

**Decision**: Reuse `redact()` from `src/slices/setup/logger/redact.ts` (patterns for Anthropic/OpenAI/AWS/GitHub/Slack/Telegram tokens, bearer headers, JWTs, URL passwords) as the baseline `redact` action, applied to the serialized `tool_result` before it enters `history` and to `sendFinalResponse` text. The transcript on disk keeps the raw result (as today for size capping) but the record notes `redacted: true`.

**Rationale**: The pattern set already exists, is tested in production logs, and lives in `setup/` so `agent/guard` may import it without breaking the dependency rule. Redacting the in-context copy, not the transcript, mirrors the CLEAN-124 split and keeps forensics possible.

**Alternatives considered**: redacting at the channel adapter — misses the model's own context, which is where a leaked token gets re-emitted from.

## R4. Secret-store protection

**Decision**: Baseline `before` rule: `exec`, `process_exec`, `file`, `unzip` calls whose arguments reference `<agentDir>/data/secrets` (path or shell string) are blocked. `secret_get` remains the only sanctioned path. Rule evaluation resolves relative paths against `ctx.agentDir`.

**Rationale**: `SecretModule` already encrypts at rest; the gap is a shell/file tool reading the ciphertext or key material. A path-match rule closes it without touching the tools.

## R5. Fail-closed vs fail-open

**Decision**: Rule *loading* is fail-closed: a malformed rule file makes `GuardService.load()` throw; `AgentRuntime` surfaces this at start and `execute()` refuses tool calls with a fixed error until fixed. Rule *evaluation* is fail-closed for `block`/`redact` actions (an evaluator exception → block with reason "rule evaluation failed") and fail-open for `record` (exception logged once per rule id, call proceeds). Observer handlers run under a bounded `Promise.race` timeout of 2 s, after which they are abandoned.

**Rationale**: Spec FR-004. The 2 s bound matches ECC's observer timeout (`observe-runner.js`, 10 s) scaled to a chat agent's latency budget.

## R6. Context budget accounting

**Decision**: A `contextBudget` section in `agent.config.json` with per-section character allowances (`soul`, `tooling`, `skillsCatalog`, `memory`, `dailyNotes`, `alwaysSkills`) defaulting to the current `DEFAULT_MEMORY_LIMITS` values where they exist. `AgentService.buildSystemPrompt` (`agent.service.ts:60-135`) returns a `{ prompt, sections: [{name, chars}] }` breakdown; `RuntimeService.buildPrompt` logs it and exposes the last breakdown per session to a `/context` command and to `agent_status`. The identity file keeps its `soul` cap but a new `## Rules` heading inside `SOUL.md` is exempt from top-truncation: the memory gateway truncates reference sections first.

**Rationale**: Characters are already the unit (`MemoryLimits` comment: model-independent). Reporting from the one function that assembles the prompt costs nothing and gives SC-009 for free.

**Alternatives considered**: token counting via the provider — accurate but provider-specific and a network call; characters at ~2.75/token are sufficient for a budget.

## R7. Skill selection by the model

**Decision**: Replace `SkillService.select()` keyword overlap (`skill.service.ts:26-46`) with a two-stage scheme: (1) the catalogue stays in the prompt (names + descriptions, as today); (2) a new always-available tool `skill_load { name }` returns the skill body into the tool result, so the model pulls a skill when its description matches the task. Loaded skills are remembered per session for `skills.retainTurns` turns (default 3) and re-injected at the top of history as a `summary`-type event rather than appended to the system prompt, keeping the cached prefix stable. The keyword matcher is kept behind `skills.selection: "keyword" | "model"` for one release as a fallback.

**Rationale**: This is how Claude Code and ECC load skills (description-driven, model-decided) and how `skill_write` already round-trips. Putting the loaded body in history instead of the system prompt preserves the 1h prompt-cache prefix (`buildSystemParam`) — appending to the system prompt as today invalidates the cache on every skill match.

**Alternatives considered**:
- Embedding similarity on descriptions — needs an embedding model and index; overkill for ≤30 skills per agent.
- Aux-model classification before each turn — an extra LLM call per message; the tool approach costs one call only when a skill is needed.

## R8. Tool catalogue budget

**Decision**: `ToolService.buildToolingPromptFrom` emits full descriptions for a configurable *core* set (default: the built-ins listed in `.agent/skills/runtime-tools`) and one-line stubs for the rest; a `tool_describe { name }` tool returns a tool's full description and JSON schema. Tool *schemas* are still sent to the provider on every call (the API needs them) — the budget applies to the prose catalogue, which is where MCP integrations balloon.

**Rationale**: Provider tool schemas sit before the system prompt in the cache prefix and are cheap once cached; the prose duplication in `## Tooling` is the part that grows the un-cached prompt. Deferred-tool loading of *schemas* (what Claude Code does) is a larger change to `ILlmGateway` and is out of scope for this feature.

## R9. Learned-behaviour store

**Decision**: A new `agent/instinct` slice. Storage: one markdown file per behaviour under `.agent/memory/instincts/<id>.md` with frontmatter `id, trigger, confidence, scope, source, pinned, evidence[], created, reinforced`, body `## Action` — the ECC instinct schema, so files are human-readable, diffable, exportable, and sync through the existing S3 path. An in-memory index (and the existing `memory.sqlite`) is a cache, not the source of truth.

Confidence model: bands `suggested` [0.3, 0.5), `apply` [0.5, 0.8), `core` [0.8, 1.0]. Starting values: correction → 0.6, error resolution → 0.5, repeated workflow → 0.5, explicit operator rule → 0.9 and `pinned`. Updates: uncorrected application +0.05 (cap 0.95), explicit correction −0.2, decay −0.05 per `decayDays` (default 14) without reinforcement, floor 0.1 → prune candidate. Numbers are configurable under `memory.instincts`.

Injection: at prompt build, instincts in `core` band are rendered under `# Memory` as standing rules; `apply` band as "Learned behaviours (apply when the trigger matches)"; `suggested` band omitted from the prompt but visible to `/learned`. Hard cap `maxInjected` (default 8) by confidence.

**Rationale**: ECC v2 gives the schema and bands (0.3 / 0.5 / 0.7 / 0.9) but leaves increments unspecified; the values above are chosen so that one correction moves a behaviour from `apply` to `suggested` (0.6 → 0.4) and three uncorrected applications bring a fresh correction-born behaviour to `core` (0.6 → 0.75 → … within six), which matches SC-004's "9 of 10". Files-over-DB keeps "an agent is just files".

**Alternatives considered**: extending `MEMORY.md ## Learned` lines with inline scores — not structured enough for evidence links and operator actions.

## R10. Observation source for learning

**Decision**: Observations come from two existing points, not from a new hook: (a) the `record` guard action writes one line per tool call to `.agent/data/toolcalls.jsonl` (tool, outcome, duration, sizes, rules fired, sessionId, turnId); (b) the existing background review (`MemoryService.reviewMemory`, every `everyTurns`) is retargeted: its prompt asks the aux model for *corrections, error resolutions and repeated workflows* in the ECC instinct shape instead of `[fact]/[workflow]` lines, with the tool-call records of those turns attached. Explicit rules ("always…", "never…" addressed to the agent by an admin) are detected by the same review pass and enter at `core`.

**Rationale**: Reuses the aux-model review that already runs after delivery; the tool-call log is the deterministic evidence ECC insists on ("hooks fire 100%"). No per-call model work.

## R11. Compaction at boundaries

**Decision**: `MemoryService.flushAndCompact` is invoked today from `RuntimeService.execute` *after* `loop.run` returns (`runtime.service.ts:~120`) — i.e. already at the task boundary. The gap is `CompactionService.compact` being triggered independently by size (`compaction.service.ts:74`) and the loop's mid-task `fitEventsToBudget`. Changes: (1) `compact()` gains a `reason` argument (`boundary` | `idle` | `hard-limit`) written into the `summary` event's data; (2) a session-level `inFlight` flag set by `TaskManager.start`/finish defers size-triggered compaction while a task runs, unless `contextBudgetChars` is within 10 % — the hard limit; (3) an idle trigger from `HeartbeatModule` compacts sessions idle > `session.idleCompactMin` (default 30) that are over threshold; (4) before summarising, `compact()` writes an in-flight note (goal from the task label, last `tool_call`s, pending inbox) as a `summary` event ahead of the archive.

**Rationale**: Spec FR-021..023 with minimal surface: one flag, one reason field, one timer. The archivist prompt already extracts key values; the in-flight note adds the "what was pending" part ECC says is lost.

## R12. Mutating-tool classification and verification

**Decision**: `Tool` gains an optional `effect?: "read" | "write"` (default `"write"` for safety; built-ins annotated: `exec`, `process_exec`, `file` write mode, `http` non-GET, `telegram_send`, `secret_set`, `cron_*`, `skill_write`, `channel_*`, MCP tools unknown → `write`). The loop tracks `mutatingCalls` per turn. When >0 and the final text exists, `VerificationService` (new, in `runtime/loop/domain/verification.service.ts`) asks the aux model with a fixed prompt: given the tool outcomes (name, outcome, first 400 chars of result) and the draft reply, return `{ ok: true }` or `{ ok: false, reply: "<rewritten factual reply>" }`. Bounded by `verification.timeoutMs` (default 8 000); on timeout the draft goes out with a trailing "(unverified)" marker. Read-only turns skip entirely.

**Rationale**: The aux model already handles background summarisation; one extra bounded call on mutating turns is the cheapest structural enforcement of "no tool call = no claim". `effect` defaulting to `write` means an unannotated MCP tool is verified rather than skipped.

**Alternatives considered**: purely deterministic check (any tool error ⇒ reply must contain "error") — too blunt; the model is needed to judge whether a claim is supported.

## R13. Delegation

**Decision**: Build on roadmap #6 (`delegate_task`): a `DelegateService` in `agent/task` that starts an internal `Task` with a fresh `history`, a filtered tool list (`tools.filter(t => !DELEGATE_BLOCKED.has(t.name))` where blocked = `delegate_task`, `memory_save`, `telegram_send`, `channel_*`, `skill_write`), a time budget, and returns `{ summary, truncated }`. Parallelism: the tool accepts an array of sub-tasks and resolves them with `Promise.allSettled`. The completion contract is enforced in the loop: a turn cannot end (`continueLoop = false`) while delegated tasks for this turn are `running`; the loop waits up to the remaining budget, then cancels and injects a system note listing partial results.

**Rationale**: Fits the existing `TaskManager` (inbox, abort controller, internal flag) and the loop's continuation mechanism. The contract check is a few lines where `continueLoop` is set.

## R14. Operator surface

**Decision**: Chat commands in `CommandService` (admin-only): `/rules` (list, which fired recently), `/context` (last breakdown for this session), `/learned [prune|pin <id>|promote <ids…>|export]`, `/compact` (manual, reason `operator`). `agent_status` tool output gains the same summaries so the agent can answer in prose. Promotion writes a skill via the existing `skill_write` path into `.agent/skills/learned-<slug>/SKILL.md` and marks the instincts `promotedTo`.

**Rationale**: SC-009 ("from chat without opening files"); every command maps to an existing module boundary.

## R15. Testing approach

**Decision**: Bun `*.spec.ts` colocated with the domain code (existing convention, 17 files). Each slice gets pure-domain tests (rule matching, confidence arithmetic, budget accounting, in-flight deferral) with no LLM; the loop-level integration (guard + verification + delegation contract) is tested with a stub `ILlmGateway` that returns scripted tool calls, as `claude.repository.spec.ts` already stubs the SDK. Evaluation sets for SC-001/003/004/007 are data files under `tests/evals/` run by a `bun run eval` script against a configured agent dir — not part of `bun test`.

---

## Resolved unknowns summary

| Unknown | Resolution |
|---|---|
| Hook point | `LoopService.executeToolCalls` via `agent/guard` (R1) |
| Rule format | Markdown + frontmatter, baseline + agent-level (R2) |
| Redaction source | `setup/logger/redact.ts` (R3) |
| Fail semantics | Load fail-closed; block/redact fail-closed; record fail-open with 2 s bound (R5) |
| Budget unit | Characters, per section, from `buildSystemPrompt` (R6) |
| Skill selection | Model-driven via `skill_load`, body into history, keyword fallback flag (R7) |
| Instinct storage | One markdown file per behaviour, ECC schema (R9) |
| Confidence numbers | Bands 0.3/0.5/0.8; +0.05 / −0.2 / −0.05 per 14 d (R9) |
| Observation source | Tool-call JSONL + retargeted review pass (R10) |
| Compaction boundary | `inFlight` flag + reason + idle timer + in-flight note (R11) |
| Mutating classification | `Tool.effect`, default `write` (R12) |
| Delegation blocked tools | `delegate_task`, `memory_save`, `telegram_send`, `channel_*`, `skill_write` (R13) |
