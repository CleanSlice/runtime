---

description: "Task list for the ECC harness principles feature"
---

# Tasks: Harness Principles for the Runtime Agent (adopted from ECC)

**Input**: Design documents from `specs/001-ecc-agent-principles/` · **Ticket**: [CLEAN-150](https://dreamvention.atlassian.net/browse/CLEAN-150)

**Prerequisites**: plan.md, spec.md, research.md (R1–R15), data-model.md, contracts/tools.md, contracts/commands-and-config.md, quickstart.md

**Tests**: Included. The repository's delivery cycle requires tests first (red → green), and plan R15 fixes the approach: Bun `*.spec.ts` colocated with domain code; loop-level specs stub `ILlmGateway`; evaluation sets under `tests/evals/` run by `bun run eval`, not by `bun test`.

**Organization**: One phase per user story in spec priority order. Each story phase is a separate PR and a separate Jira ticket under CLEAN-150. Every phase ends with `bun test` green.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: US1–US6 from spec.md
- File paths are repository-relative

## Path Conventions

CleanSlice vertical slices under `src/slices/{setup,agent,bot,runtime}/<slice>/{domain,data}/` with `<slice>.module.ts` and `index.ts`. Tools live in `src/slices/agent/tool/data/repositories/<group>/`. Specs sit next to the code they test.

---

## Phase 1: Setup

**Purpose**: Config surface and shared type changes that carry no behaviour yet.

- [X] T001 Add `contextBudget`, `skills`, `tools.coreCatalogue`, `tools.delegate`, `guard`, `memory.instincts`, `session.idleCompactMin`, `session.hardLimitPct`, `verification` to `IAgentConfig` with the defaults from contracts/commands-and-config.md in `src/slices/runtime/init/domain/init.types.ts`
- [X] T002 Merge the new config sections with defaults in the config loader so a partial `agent.config.json` still validates, in `src/slices/runtime/init/domain/init.service.ts`; add a spec case for a config that sets only `memory.instincts.decayDays` in `src/slices/runtime/init/domain/init.service.spec.ts`
- [X] T003 [P] Add `effect?: "read" | "write"` to `Tool` with the docstring "unset means write" in `src/slices/agent/tool/domain/tool.types.ts`
- [X] T004 [P] Document the new `agent.config.json` sections in the "Agent configuration" block of `README.md` and in `.agent.example/agent.config.json`
- [X] T005 [P] Add `"eval": "bun run scripts/eval.ts"` to `package.json` scripts and create the empty runner skeleton `scripts/eval.ts` that reads `tests/evals/*.jsonl` and prints a table (no assertions yet)

---

## Phase 2: Foundational

**Purpose**: Changes every story builds on: `Tool.effect` on all tools, the prompt breakdown, the task in-flight set.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T006 Annotate every built-in tool with `effect` per the read/write table in contracts/tools.md across `src/slices/agent/tool/data/repositories/**/*.repository.ts` (`file` and `http` decide per call: add `effectOf?(params)` to `Tool` in `src/slices/agent/tool/domain/tool.types.ts` and implement it for those two)
- [X] T007 Map MCP `readOnlyHint` annotations to `effect: "read"` and default the rest to `"write"` where MCP tools are built in `src/slices/setup/mcp/data/mcp.gateway.ts`
- [X] T008 Write a spec asserting every tool registered by `ToolGateway` declares `effect` (or `effectOf`) in `src/slices/agent/tool/data/tool.gateway.spec.ts`
- [X] T009 Change `AgentService.buildSystemPrompt` to return `{ prompt, breakdown: IPromptBreakdown }` with per-section char counts (soul, channel, tooling, agents, user, memory, dailyNotes, heartbeat, skillsCatalog, credentials, runtime) in `src/slices/agent/agent/domain/agent.service.ts`; add `IPromptBreakdown` to `src/slices/agent/agent/domain/agent.types.ts`; update the two callers in `src/slices/agent/agent/agent.module.ts` and `src/slices/runtime/runtime/domain/runtime.service.ts`
- [X] T010 Spec for the breakdown: section sums equal prompt length, sections absent for non-admin are reported as 0, in `src/slices/agent/agent/domain/agent.service.spec.ts`
- [X] T011 Keep the last `IPromptBreakdown` per session in `RuntimeService` (`lastBreakdown: Map<sessionId, IPromptBreakdown>`) and expose `getLastBreakdown(sessionId)` in `src/slices/runtime/runtime/domain/runtime.service.ts`
- [X] T012 Add `inFlight(sessionId): boolean`, `parentTaskId?` on `ITask`, and `getChildren(parentTaskId)` to the task manager in `src/slices/agent/task/domain/task.types.ts`, `src/slices/agent/task/domain/task.service.ts`, `src/slices/agent/task/data/task.gateway.ts`; spec in `src/slices/agent/task/domain/task.service.spec.ts`

**Checkpoint**: `bun test` green; no user-visible behaviour change.

---

## Phase 3: User Story 1 — Guardrails that fire every time (Priority: P1) 🎯 MVP

**Goal**: Deterministic rules around every tool call: block, redact, record; platform baseline plus agent-level files; fail-closed loading.

**Independent Test**: quickstart.md §US1 — ten attempts to read `data/secrets/` are all blocked and recorded; a token-shaped string in a tool result reaches the model redacted; a malformed rule file is reported and refused.

### Tests for User Story 1

- [X] T013 [P] [US1] Rule matcher spec (tool glob incl. `a|b` and `mcp__*`, JSON-path `$` and `$.method`, regex on args and on serialized result, relative path resolution against `agentDir`) in `src/slices/agent/guard/domain/rule.matcher.spec.ts`
- [X] T014 [P] [US1] Guard service spec: strictest-wins composition, protected baseline cannot be overridden by an agent rule with the same id, malformed rule file → `load()` throws naming file and field, observer handler exception → call proceeds and is logged once, observer over `observerTimeoutMs` → abandoned, in `src/slices/agent/guard/domain/guard.service.spec.ts`
- [X] T015 [P] [US1] Loop integration spec with a stubbed `ILlmGateway` that returns a scripted `exec cat data/secrets/x` call: tool not executed, `tool_result` carries `blocked: true` and the rule reason, record line written, in `src/slices/runtime/loop/domain/loop.service.spec.ts`

### Implementation for User Story 1

- [X] T016 [P] [US1] Create `IRule`, `IRuleMatch`, `RuleAction`, `IToolCallRecord`, `IGuardOutcome` in `src/slices/agent/guard/domain/guard.types.ts`
- [X] T017 [P] [US1] Create `IGuardGateway` (`loadRules(): IRule[]`, `appendRecord(IToolCallRecord)`) in `src/slices/agent/guard/domain/guard.gateway.ts`
- [X] T018 [US1] Implement the pure matcher `matches(rule, call)` in `src/slices/agent/guard/domain/rule.matcher.ts`
- [X] T019 [US1] Implement `GuardService` (`load()`, `before(call, ctx)`, `after(call, result, ctx)`, composition, fail semantics from R5, once-per-rule error logging) in `src/slices/agent/guard/domain/guard.service.ts`
- [X] T020 [US1] Implement the file gateway: parse `.agent/rules/*.md` and the bundled baseline with `gray-matter`, validate ids and event/match pairing, append JSONL records with size rotation at `guard.recordMaxBytes`, in `src/slices/agent/guard/data/guard.gateway.ts`
- [X] T021 [P] [US1] Write the five baseline rule files (`no-secret-store-reads`, `no-env-reads`, `redact-credentials`, `cap-result-size`, `record-all`) with `protected: true` in `src/slices/agent/guard/data/baseline/*.md`; `redact-credentials` reuses `redact()` from `src/slices/setup/logger/redact.ts`
- [X] T022 [US1] Create `GuardModule` and `index.ts` exposing `load()`, `before()`, `after()`, `listRules()`, `recentFirings(hours)` in `src/slices/agent/guard/guard.module.ts` and `src/slices/agent/guard/index.ts`
- [X] T023 [US1] Intercept in `LoopService.executeToolCalls`: call `guard.before` after the admin-only check and before `tool.execute`; on block skip execution and set `result = { error: "blocked by rule <id>: <reason>" }`; call `guard.after` on the result before `capPayload`; move the size cap under the `cap-result-size` rule; pass `blocked`/`redacted` flags into the `tool_result` event, in `src/slices/runtime/loop/domain/loop.service.ts` and `src/slices/runtime/loop/domain/loop.types.ts` (add `guard` to `LoopServiceDeps`)
- [X] T024 [US1] Wire `GuardModule` in `AgentRuntime`: construct with `agentDir`, `await guard.load()` in `start()`; on failure log the error and set a `guardLoadError` that makes every tool call return `{ error: "rules failed to load: …" }` until fixed, in `src/slices/runtime/runtime/runtime.module.ts` and `src/slices/runtime/runtime/domain/runtime.service.ts`
- [X] T025 [US1] Add `/rules` and `/rules reload` (admin-only; reload keeps the previous set on error and replies with file + reason) in `src/slices/bot/command/domain/command.service.ts`; add `guard` to `CommandDeps`
- [X] T026 [US1] Add the `rules` summary (`count`, `firedLast24h`) to `agent_status` output in `src/slices/agent/tool/data/repositories/status/agent_status.repository.ts` (reads via `ctx.guard`, added to `ToolContext` in `src/slices/agent/tool/domain/tool.types.ts`)
- [X] T027 [US1] Create the adversarial eval set (≥30 prompts: direct, roleplay, "for debugging", via skill, via `http` to a file URL) in `tests/evals/guardrails.jsonl` and the `blocked` assertion mode in `scripts/eval.ts`
- [X] T028 [US1] Document rules (format, baseline table, `/rules`) in a new "Guardrails" section of `README.md` and ship an example `.agent.example/rules/README.md`

**Checkpoint**: US1 fully functional; `bun test` green; `bun run eval tests/evals/guardrails.jsonl` → 100 % blocked.

---

## Phase 4: User Story 2 — Lean always-on context, knowledge on demand (Priority: P1)

**Goal**: Rules-only identity file within budget, skills pulled by the model with `skill_load`, tool details via `tool_describe`, and a visible context breakdown.

**Independent Test**: quickstart.md §US2 — after moving the ranch endpoint table into a skill, `/context` shows `soul` ≥40 % smaller with no `over`; a question phrased without the skill's keywords triggers `skill_load ranch`; an unsatisfiable skill is listed as unavailable.

### Tests for User Story 2

- [X] T029 [P] [US2] Spec: `## Rules` heading in `SOUL.md` is never top-truncated, other headings go first, `over` reported when rules alone exceed the cap, in `src/slices/agent/memory/data/repositories/file/file.repository.spec.ts`
- [X] T030 [P] [US2] Spec: per-session loaded skills retained `retainTurns` turns then released; `requires.env`/`bins` unmet → not loadable with the stated reason; `selection: "keyword"` still uses the old matcher, in `src/slices/agent/skill/domain/skill.service.spec.ts`
- [X] T031 [P] [US2] Spec: catalogue emits full descriptions only for `coreCatalogue`, stubs for the rest, total within `contextBudget.sections.tooling`, in `src/slices/agent/tool/domain/tool.service.spec.ts`
- [X] T032 [P] [US2] Spec: `skill_load` places a `summary` event `[SKILL <name>]` at the top of history and does not change `systemPrompt` (prompt-cache prefix stays stable), in `src/slices/runtime/loop/domain/loop.service.spec.ts`

### Implementation for User Story 2

- [X] T033 [US2] Make `truncateOldest` heading-aware: drop non-`## Rules` sections first and surface an `over` flag, in `src/slices/agent/memory/data/repositories/file/file.repository.ts`; add `contextBudget` checks and start-up warning naming the file and sections in `src/slices/agent/memory/data/memory.gateway.ts`
- [X] T034 [US2] Add per-session loaded-skill state (`load(sessionId, name, turn)`, `activeFor(sessionId, turn)`, release after `retainTurns`), the `requires` availability check with reason, and the `selection` flag, in `src/slices/agent/skill/domain/skill.service.ts` and `src/slices/agent/skill/skill.module.ts`
- [X] T035 [US2] Append `(unavailable: missing env X)` to catalogue entries of unsatisfiable skills and render the instinct/skill sections from the breakdown in `src/slices/agent/agent/domain/agent.service.ts`
- [X] T036 [P] [US2] Create the `skill_load` tool (schema `{ name }`, returns `{ name, chars, retainedForTurns }`, errors `unknown skill` / `skill unavailable: …`, `effect: "read"`) in `src/slices/agent/tool/data/repositories/skill/skill_load.repository.ts`
- [X] T037 [P] [US2] Create the `tool_describe` tool (returns description, JSON schema, `effect`, `adminOnly`; reads `ctx.tools`) in `src/slices/agent/tool/data/repositories/tool/tool_describe.repository.ts`
- [X] T038 [US2] Register both tools in `src/slices/agent/tool/data/tool.gateway.ts` and list them in `.agent/skills/runtime-tools/SKILL.md`
- [X] T039 [US2] Split `buildToolingPromptFrom` into core (full) and stub (one line + "call `tool_describe`") sections driven by `tools.coreCatalogue`, in `src/slices/agent/tool/domain/tool.service.ts`
- [X] T040 [US2] In the loop: when `skill_load` succeeds, insert the skill body as a `summary` event at the head of `ctx.history` (after any leading archive summary) and record it in the session's loaded set; re-insert active skills on later turns when rebuilding history, in `src/slices/runtime/loop/domain/loop.service.ts` and `src/slices/runtime/runtime/domain/runtime.service.ts` (`buildHistory`)
- [X] T041 [US2] Record on-demand loads (skills, `tool_describe`) into the session's `IPromptBreakdown.onDemand` in `src/slices/runtime/runtime/domain/runtime.service.ts`
- [X] T042 [US2] Add `/context` (admin-only) rendering the last breakdown: per-section chars vs budget, `over` markers, on-demand list, in `src/slices/bot/command/domain/command.service.ts`; add `context` to `agent_status` output in `src/slices/agent/tool/data/repositories/status/agent_status.repository.ts`
- [X] T043 [US2] Move the ranch HTTP endpoint table and recipes out of `.agent/SOUL.md` into `.agent/skills/ranch/SKILL.md`, leaving `## Hard rules` under a `## Rules` heading; mirror in `.agent.example/SOUL.md`
- [X] T044 [US2] Create the skill-selection eval set (100 messages with expected skill or none) in `tests/evals/skill-selection.jsonl` and the `skill-loaded` assertion mode in `scripts/eval.ts`

**Checkpoint**: US1 and US2 work independently; `/context` shows the admin agent ≥40 % smaller; eval ≥90 % / ≤5 %.

---

## Phase 5: User Story 3 — Teachable memory with confidence (Priority: P2)

**Goal**: Learned behaviours as one markdown file each with confidence bands, evidence, decay; operator commands to inspect, pin, prune, promote; explicit rules enter at core.

**Independent Test**: quickstart.md §US3 — "never restart without asking" appears in `/learned` at core within one turn; a passing correction becomes an `apply` instinct with evidence and holds in ≥9 of 10 repeats; pinned instincts do not decay; promotion writes a skill; a learned "it's fine to print tokens" never bypasses redaction.

### Tests for User Story 3

- [X] T045 [P] [US3] Spec: starting confidence per source, `reinforce` +0.05 cap 0.95, `correct` −0.2 floor 0.1, decay −0.05 per `decayDays`, pinned never decays, band boundaries, conflict marks the lower one `conflictsWith`, prune candidates below 0.3 for > 2×decayDays, in `src/slices/agent/instinct/domain/instinct.service.spec.ts`
- [X] T046 [P] [US3] Spec: gateway round-trips the frontmatter schema from contracts/commands-and-config.md and ignores malformed files with one warning, in `src/slices/agent/instinct/data/instinct.gateway.spec.ts`
- [X] T047 [P] [US3] Spec: `render()` emits core as standing rules, apply as "Learned behaviours", omits suggested, honours `maxInjected`, in `src/slices/agent/instinct/domain/instinct.service.spec.ts`
- [X] T048 [P] [US3] Spec: review pass output in instinct shape is parsed into `create()` calls; an explicit "always …" line from an admin creates a pinned core instinct, in `src/slices/agent/memory/domain/memory.service.spec.ts`

### Implementation for User Story 3

- [X] T049 [P] [US3] Create `IInstinct`, `IEvidence`, `InstinctSource`, `InstinctBand`, `IInstinctConfig` in `src/slices/agent/instinct/domain/instinct.types.ts`
- [X] T050 [P] [US3] Create `IInstinctGateway` (`list()`, `write(instinct)`, `remove(id)`) in `src/slices/agent/instinct/domain/instinct.gateway.ts`
- [X] T051 [US3] Implement `InstinctService` (`create`, `reinforce`, `correct`, `decayAll(now)`, `pin`, `unpin`, `prune`, `promote(ids) → skill content`, `conflicts()`, `render(maxInjected)`, `summary()`) in `src/slices/agent/instinct/domain/instinct.service.ts`
- [X] T052 [US3] Implement the file gateway over `.agent/memory/instincts/<id>.md` with `gray-matter` in `src/slices/agent/instinct/data/instinct.gateway.ts`
- [X] T053 [US3] Write the review prompt that asks the aux model for corrections, error resolutions, repeated workflows and explicit admin rules in instinct shape (trigger / action / source / evidence refs), replacing the `[fact]/[workflow]` prompt, in `src/slices/agent/instinct/domain/prompts/instinct-review.prompt.ts`
- [X] T054 [US3] Create `InstinctModule` and `index.ts` in `src/slices/agent/instinct/instinct.module.ts` and `src/slices/agent/instinct/index.ts`
- [X] T055 [US3] Retarget `MemoryService.doReview` to call the instinct prompt, attach the turn's tool-call records as evidence, and hand results to `InstinctService.create`; keep `MEMORY.md ## Learned` writes only for `[fact]` lines, in `src/slices/agent/memory/domain/memory.service.ts` and `src/slices/agent/memory/memory.module.ts`
- [X] T056 [US3] Reinforce on use: when a turn ends without a correction and an `apply`/`core` instinct was injected, call `reinforce` for the injected ids (loop passes the injected list via `ILoopContext`), in `src/slices/runtime/loop/domain/loop.service.ts` and `src/slices/runtime/runtime/domain/runtime.service.ts`
- [X] T057 [US3] Inject `render()` output under `# Memory` in `buildSystemPrompt` with its own `instincts` budget section in `src/slices/agent/agent/domain/agent.service.ts`
- [X] T058 [US3] Run `decayAll` from the heartbeat tick (once per day, persisted `lastDecay` in `.agent/data/instincts.json`) in `src/slices/agent/heartbeat/heartbeat.module.ts` and wire in `src/slices/runtime/runtime/runtime.module.ts`
- [X] T059 [US3] Add `/learned`, `/learned show <id>`, `/learned pin|unpin <id>`, `/learned prune [<id>]`, `/learned promote <id…>` (writes via the skill gateway to `.agent/skills/learned-<slug>/SKILL.md`, marks `promotedTo`, reloads skills), `/learned export` (attachment), in `src/slices/bot/command/domain/command.service.ts`
- [X] T060 [US3] Add the `learned` summary to `agent_status` in `src/slices/agent/tool/data/repositories/status/agent_status.repository.ts`
- [X] T061 [US3] Create the corrections eval set (correction turn + 10 follow-ups each, expected behaviour) in `tests/evals/corrections.jsonl` and the `holds-after-correction` assertion mode in `scripts/eval.ts`
- [X] T062 [US3] Document instincts (bands, numbers, commands, FR-016 guarantee) in a "Learning" section of `README.md`

**Checkpoint**: US3 works independently of US2; `bun test` green; corrections eval ≥9/10.

---

## Phase 6: User Story 4 — Compaction at task boundaries (Priority: P2)

**Goal**: Compaction deferred while a task is in flight (hard limit excepted), triggered on boundary / idle / operator, with an in-flight note and a recorded reason.

**Independent Test**: quickstart.md §US4 — with a low threshold, no `summary` event appears mid-task; the first one after the reply has `reason: boundary` and an `inFlight` block; idle compaction fires after `idleCompactMin`; `/compact` reports counts.

### Tests for User Story 4

- [ ] T063 [P] [US4] Spec: `compact()` with `inFlight` true and size below `hardLimitPct` is a no-op; above it proceeds with `reason: "hard-limit"`; summary event carries `reason` and `inFlight` note; `operator` reason bypasses thresholds, in `src/slices/agent/session/domain/compaction.service.spec.ts`
- [ ] T064 [P] [US4] Spec: idle sweep compacts only sessions idle > `idleCompactMin` and over threshold, in `src/slices/agent/session/session.module.spec.ts`

### Implementation for User Story 4

- [ ] T065 [US4] Add `reason` and `inFlight` to the `summary` event data type in `src/slices/setup/event/domain/event.types.ts`
- [ ] T066 [US4] Extend `CompactionService.compact(sessionId, llm, opts: { reason, inFlight: boolean, force?: boolean })`: hard-limit gate from `session.hardLimitPct × contextBudgetChars`, in-flight note built from the task label, last three `tool_call` names and the inbox, written ahead of the archive summary, in `src/slices/agent/session/domain/compaction.service.ts`
- [ ] T067 [US4] Pass `inFlight` from `TaskManager` and the `boundary` reason from the post-turn call in `src/slices/agent/memory/domain/memory.service.ts` (`doFlush`) and `src/slices/runtime/runtime/domain/runtime.service.ts`
- [ ] T068 [US4] Add `compactIdle(now)` to `SessionModule` and call it from the heartbeat tick with `session.idleCompactMin`, in `src/slices/agent/session/session.module.ts`, `src/slices/agent/heartbeat/heartbeat.module.ts`, `src/slices/runtime/runtime/runtime.module.ts`
- [ ] T069 [US4] Add `/compact` (admin-only, reason `operator`, replies with before/after event counts) in `src/slices/bot/command/domain/command.service.ts`
- [ ] T070 [US4] Log each compaction with its reason at info level and surface the last reason in `agent_status` in `src/slices/agent/tool/data/repositories/status/agent_status.repository.ts`

**Checkpoint**: Mid-task compaction only on hard limit; `bun test` green.

---

## Phase 7: User Story 5 — Verified completion (Priority: P3)

**Goal**: After a mutating tool ran, the draft reply is checked against tool outcomes by the aux model within a time bound; unsupported claims are rewritten; read-only turns untouched.

**Independent Test**: quickstart.md §US5 — an `http` call returning 500 yields a reply quoting the status; a read-only turn has no verification log line; `timeoutMs: 1` delivers the draft with `(unverified)`.

### Tests for User Story 5

- [ ] T071 [P] [US5] Spec: `VerificationService.verify(draft, outcomes)` returns `ok` for a supported claim, rewritten reply for an unsupported one, `timedOut` with the draft untouched past `timeoutMs`, skipped when no `write` outcome exists, in `src/slices/runtime/loop/domain/verification.service.spec.ts`
- [ ] T072 [P] [US5] Loop spec: a scripted turn with one `write` tool error and a "done" draft sends the rewritten reply; a read-only turn never calls the aux gateway, in `src/slices/runtime/loop/domain/loop.service.spec.ts`

### Implementation for User Story 5

- [ ] T073 [P] [US5] Write the verification prompt (inputs: tool name, outcome, first 400 chars of result; draft reply; output JSON `{ ok } | { ok: false, reply }`) in `src/slices/runtime/loop/domain/prompts/verification.prompt.ts`
- [ ] T074 [US5] Implement `VerificationService` over `llm.auxComplete` with `Promise.race` against `verification.timeoutMs`, in `src/slices/runtime/loop/domain/verification.service.ts`
- [ ] T075 [US5] Track `mutatingCalls` per turn from `effect`/`effectOf` in `executeToolCalls`; before `sendFinalResponse`, run verification when non-empty and `verification.enabled`; on `!ok` replace the text, on timeout append ` (unverified)`; log `verification: ok|rewritten|timeout|skipped`, in `src/slices/runtime/loop/domain/loop.service.ts`
- [ ] T076 [US5] Create the completion-claims eval set (mutating tasks with failing backends, expected "no success claim") in `tests/evals/completion-claims.jsonl` and the `no-false-done` assertion mode in `scripts/eval.ts`

**Checkpoint**: `bun test` green; completion-claims eval ≥50 % fewer false "done" than baseline recorded in the eval file header.

---

## Phase 8: User Story 6 — Delegation with a completion contract (Priority: P3)

**Goal**: `delegate_task` fans sub-tasks out to isolated internal tasks with a restricted toolset and a time budget; the parent waits for all children before ending its turn.

**Independent Test**: quickstart.md §US6 — five goals run as five internal tasks with `parentTaskId`; one consolidated reply; a worker cannot send messages; a 1 s budget yields `timeout` statuses reported by the parent.

### Tests for User Story 6

- [ ] T077 [P] [US6] Spec: worker tool list excludes `DELEGATE_BLOCKED`, workers get a fresh history and `internal: true`, `Promise.allSettled` fan-out respects `maxParallel`, budget expiry cancels and returns `timeout`, summaries truncated at `summaryChars`, in `src/slices/agent/task/domain/delegate.service.spec.ts`
- [ ] T078 [P] [US6] Loop spec: a parent turn whose text-only response arrives while a child is `running` does not end; it waits, then injects a system note with partial results on budget expiry, in `src/slices/runtime/loop/domain/loop.service.spec.ts`

### Implementation for User Story 6

- [ ] T079 [P] [US6] Create `IDelegateRequest`, `IDelegateResult`, `DELEGATE_BLOCKED` in `src/slices/agent/task/domain/delegate.types.ts`
- [ ] T080 [US6] Implement `DelegateService.run(parentTask, requests, ctx)` using `TaskManager.start` with `parentTaskId`, a filtered tool list, `LoopService.run` with fresh history and `isInternal: true`, per-request `AbortController` timeout, in `src/slices/agent/task/domain/delegate.service.ts`; export from `src/slices/agent/task/task.module.ts`
- [ ] T081 [US6] Create the `delegate_task` tool (admin-only, `effect: "write"`, schema `{ tasks: [{ goal, context?, timeoutMs? }] }`, blocked inside workers by name) in `src/slices/agent/tool/data/repositories/delegate/delegate.repository.ts`; register in `src/slices/agent/tool/data/tool.gateway.ts`; add `delegate` to `ToolContext` in `src/slices/agent/tool/domain/tool.types.ts`
- [ ] T082 [US6] Enforce the completion contract: before setting `continueLoop = false`, check `tasks.getChildren(task.id)` for `running`; await them up to the remaining budget, else cancel and push a `user` event listing partial results, in `src/slices/runtime/loop/domain/loop.service.ts`
- [ ] T083 [US6] Wire `DelegateService` into the loop deps and the tool context in `src/slices/runtime/runtime/runtime.module.ts`; mark `spawn_agent` as the external-coding-agent path in its description in `src/slices/agent/tool/data/repositories/exec/spawn_agent.repository.ts`
- [ ] T084 [US6] Show child tasks indented under their parent in `/tasks` in `src/slices/bot/command/domain/command.service.ts`

**Checkpoint**: All six stories functional; `bun test` green.

---

## Phase 9: Polish & Cross-Cutting

- [ ] T085 [P] Complete `scripts/eval.ts`: run every `tests/evals/*.jsonl`, print pass rates, exit non-zero when any SC threshold (100 % / 90 % / 5 % / 90 % / 50 %) is missed; add an `eval` job to `.github/workflows/publish-runtime.yml` that runs on `main` only
- [ ] T086 [P] Update `IMPROVEMENT_PLAN.md`: mark #4 Curator, #6 Delegation, #10 Safety pipeline, #15 Lifecycle hooks as superseded by this feature with links to the phases
- [ ] T087 [P] Add the new commands to `/help` and the README "Bot commands" table in `src/slices/bot/command/domain/command.service.ts` and `README.md`
- [ ] T088 [P] Update slice READMEs with the `guard` and `instinct` rows in `src/slices/agent/README.md`
- [ ] T089 Run quickstart.md end-to-end against a dev agent and record results in `specs/001-ecc-agent-principles/checklists/quickstart-results.md`
- [ ] T090 Release: bump `package.json` version, changelog entry, tag per `release.yml`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)** → **Foundational (Phase 2)** → stories.
- **US1 (Phase 3)** first: its record file is the evidence source for US3 and the `blocked` outcome for US5/US6 scenarios; its loop interception is where US5 reads `mutatingCalls`.
- **US2 (Phase 4)** and **US4 (Phase 6)** depend only on Phase 2.
- **US3 (Phase 5)** depends on US1 (records) and on T009 (breakdown) for its budget section.
- **US5 (Phase 7)** depends on US1 (loop interception + `effect` tracking).
- **US6 (Phase 8)** depends on Phase 2 (`parentTaskId`) and on US1 for the blocked-tool result; the completion contract touches the same loop region as US5 — do US5 first or coordinate.
- **Polish (Phase 9)** after all desired stories.

### Within Each Story

Tests → types/gateway interface → service → data gateway → module → loop/runtime wiring → commands/status → eval set → docs.

### Parallel Opportunities

- Phase 1: T003, T004, T005 together.
- Phase 2: T006/T007 together, then T008; T009–T011 in sequence; T012 independent.
- US1: T013–T015 together; T016, T017, T021 together; T018 → T019 → T020 → T022 → T023 → T024 → T025/T026 together.
- US2: T029–T032 together; T036, T037 together after T034.
- US3: T045–T048 together; T049, T050 together; T051 → T052 → … ; T059/T060 together.
- Across stories after Phase 3: US2, US4 can run in parallel with US3.

## Parallel Example: User Story 1

```bash
# Tests first, in parallel:
Task: "Rule matcher spec in src/slices/agent/guard/domain/rule.matcher.spec.ts"
Task: "Guard service spec in src/slices/agent/guard/domain/guard.service.spec.ts"
Task: "Loop integration spec in src/slices/runtime/loop/domain/loop.service.spec.ts"

# Then the independent files:
Task: "guard.types.ts"
Task: "guard.gateway.ts (interface)"
Task: "baseline/*.md"
```

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 + Phase 2.
2. Phase 3 (US1): guardrails. Validate with quickstart §US1 and the guardrails eval.
3. Ship: this alone changes the safety class of every agent.

### Incremental Delivery

Each story is one PR and one Jira ticket under CLEAN-150; merge order US1 → US2 → US3 → US4 → US5 → US6 → Polish. US2 and US4 may land in either order relative to US3.

## Notes

- `gray-matter` is already a dependency — no new packages.
- Keep `selection: "keyword"` (T034) for one release, then delete it.
- Rules never relax from learned behaviour by construction (instincts render into the prompt; rules run in the loop) — no runtime check needed, but T045 asserts instincts never reach `GuardService`.
- Commit after each task group; never commit `.env.project`.
