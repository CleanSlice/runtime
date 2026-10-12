# Implementation Plan: Harness Principles for the Runtime Agent (adopted from ECC)

**Branch**: `docs/CLEAN-150-ecc-agent-principles` | **Date**: 2026-10-12 | **Spec**: [spec.md](spec.md) | **Ticket**: [CLEAN-150](https://dreamvention.atlassian.net/browse/CLEAN-150)

**Input**: Feature specification from `specs/001-ecc-agent-principles/spec.md`

## Summary

Make six ECC harness principles structural in the runtime so every agent gets them by default: (1) deterministic guardrails around each tool call, (2) a budgeted always-on prompt with skills and tool details pulled on demand by the model, (3) confidence-weighted learned behaviours the operator can inspect and steer from chat, (4) compaction only at task boundaries with state saved first, (5) a bounded verification pass before any completion claim after a mutating tool, (6) delegation to isolated workers under a completion contract.

Technical approach: two new agent slices (`agent/guard`, `agent/instinct`), one interception point in the existing loop, extensions to prompt assembly, skill loading, compaction and the task manager, plus operator commands. All state stays as files in `.agent/`. Background work rides the auxiliary model. Design details and the alternatives rejected are in [research.md](research.md).

## Technical Context

**Language/Version**: TypeScript on Bun ≥1.2 (`bun run`, `bun test`, `bun build --target bun`)

**Primary Dependencies**: `@anthropic-ai/sdk` 0.79, `@modelcontextprotocol/sdk` 1.29, `zod` 3 + `zod-to-json-schema`, `gray-matter` (frontmatter — reused for rule and instinct files). No new runtime dependencies.

**Storage**: Files under the agent directory — markdown with frontmatter (rules, instincts), JSONL (tool-call records, sessions), `agent.config.json` (budgets, thresholds). `memory.sqlite` stays a search cache.

**Testing**: `bun test` with colocated `*.spec.ts` (17 today); loop-level specs stub `ILlmGateway`. Evaluation sets under `tests/evals/*.jsonl` driven by a `bun run eval` script (not part of `bun test`).

**Target Platform**: Linux containers (runtime image); developer machines on macOS/Windows for tests.

**Project Type**: Long-running service (agent runtime) with a CLI; single package.

**Performance Goals**: Guard evaluation adds <5 ms per tool call (pure matching, no I/O on the hot path except the append to the record file); observer handlers bounded at 2 s; verification bounded at 8 s and only on mutating turns; no extra model call on read-only turns; prompt-cache prefix (`buildSystemParam`) unchanged by on-demand skill loads (they enter history, not the system prompt).

**Constraints**: Dependency rule of CleanSlice slices (`agent → setup` only; `runtime → all`) — new slices live under `agent/` and import only from `setup/`. Rules can never be relaxed by learned behaviours (FR-016) — enforced by construction: instincts render into the prompt, rules run in the loop. Fail-closed loading of rules; fail-open observers.

**Scale/Scope**: Per agent: ≤50 rules, ≤200 instincts, ≤30 skills, 60–120 tools (built-in + MCP). Sessions up to `contextBudgetChars` 400 k chars. Dozens of agents per ranch; nothing here is cross-agent except explicit promotion.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled template (no ratified principles), so there are no constitution gates to evaluate. The checks applied instead are the repository's own stated rules:

| Rule (source) | Status |
|---|---|
| Slice dependency direction — `src/slices/*/README.md` | PASS: `agent/guard` imports `setup/logger/redact`; `agent/instinct` imports `setup/llm` types only; loop/runtime wire them. |
| "An agent is just files" — `README.md` | PASS: rules, instincts, records are files in `.agent/`. |
| Tests colocated, `bun test` green before PR — `CLAUDE.md` delivery cycle | PASS: planned per slice (R15). |
| Mutating tools marked admin-only — `tool.types.ts` | PASS and extended: `effect` annotation (R12). |
| Prompt-cache prefix stability — `claude.repository.ts` docstring | PASS: on-demand loads go into history (R7). |

Post-design re-check (after Phase 1): no violations introduced; no Complexity Tracking entries needed.

## Project Structure

### Documentation (this feature)

```text
specs/001-ecc-agent-principles/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions R1–R15
├── data-model.md        # Phase 1 — entities, bands, transitions
├── quickstart.md        # Phase 1 — validation scenarios per user story
├── contracts/
│   ├── tools.md                 # skill_load, tool_describe, delegate_task, agent_status, Tool.effect
│   └── commands-and-config.md   # /rules /context /learned /compact, agent.config.json, file formats
└── tasks.md             # Phase 2 — /speckit-tasks (not created here)
```

### Source Code (repository root)

```text
src/slices/
├── agent/
│   ├── guard/                              # NEW — US1
│   │   ├── domain/
│   │   │   ├── guard.types.ts              # IRule, IRuleMatch, IToolCallRecord, outcomes
│   │   │   ├── guard.service.ts            # load(), before(), after(), compose(); fail semantics
│   │   │   ├── guard.service.spec.ts
│   │   │   ├── rule.matcher.ts             # glob + JSON-path + regex matching (pure)
│   │   │   └── rule.matcher.spec.ts
│   │   ├── data/
│   │   │   ├── guard.gateway.ts            # reads .agent/rules/*.md + baseline/, appends toolcalls.jsonl
│   │   │   └── baseline/*.md               # protected platform rules
│   │   ├── guard.module.ts
│   │   └── index.ts
│   ├── instinct/                           # NEW — US3
│   │   ├── domain/
│   │   │   ├── instinct.types.ts           # IInstinct, bands, config
│   │   │   ├── instinct.service.ts         # create/reinforce/correct/decay/pin/prune/promote, render()
│   │   │   ├── instinct.service.spec.ts    # confidence arithmetic, band transitions, conflict rule
│   │   │   └── prompts/instinct-review.prompt.ts   # replaces [fact]/[workflow] review prompt
│   │   ├── data/instinct.gateway.ts        # one markdown file per instinct
│   │   ├── instinct.module.ts
│   │   └── index.ts
│   ├── agent/domain/agent.service.ts       # CHANGED — US2: breakdown return, ## Rules exemption, instinct section
│   ├── memory/domain/memory.service.ts     # CHANGED — US3: review pass delegates to InstinctService
│   ├── memory/data/…                       # CHANGED — US2: truncate reference headings before ## Rules
│   ├── skill/domain/skill.service.ts       # CHANGED — US2: per-session loaded set, requires check, keyword flag
│   ├── session/domain/compaction.service.ts  # CHANGED — US4: reason, inFlight note, hard-limit gate
│   ├── session/session.module.ts           # CHANGED — US4: idle trigger entry point
│   ├── task/domain/task.service.ts         # CHANGED — US4/US6: inFlight set, parentTaskId, children query
│   ├── task/domain/delegate.service.ts     # NEW — US6: DELEGATE_BLOCKED, fan-out, budgets
│   └── tool/
│       ├── domain/tool.types.ts            # CHANGED — effect?: "read" | "write"
│       ├── domain/tool.service.ts          # CHANGED — US2: core vs stub catalogue
│       └── data/repositories/
│           ├── skill/skill_load.repository.ts      # NEW
│           ├── tool/tool_describe.repository.ts    # NEW
│           ├── delegate/delegate.repository.ts     # NEW
│           └── status/agent_status.repository.ts   # CHANGED — context/rules/learned fields
├── bot/command/domain/command.service.ts   # CHANGED — /rules /context /learned /compact
├── runtime/
│   ├── init/domain/init.types.ts           # CHANGED — contextBudget, skills, guard, instincts, verification, session.idleCompactMin
│   ├── loop/domain/
│   │   ├── loop.service.ts                 # CHANGED — guard before/after, mutatingCalls, completion contract
│   │   ├── loop.service.spec.ts            # NEW — stubbed-LLM integration: block, redact, verify, wait-for-children
│   │   ├── verification.service.ts         # NEW — US5
│   │   └── prompts/verification.prompt.ts  # NEW
│   └── runtime/
│       ├── runtime.module.ts               # CHANGED — wire GuardModule, InstinctModule, idle compaction
│       └── domain/runtime.service.ts       # CHANGED — breakdown capture, skill_load wiring, fail-closed start
tests/
└── evals/                                  # NEW — guardrails.jsonl, skill-selection.jsonl, corrections.jsonl, completion-claims.jsonl
scripts/eval.ts                             # NEW — bun run eval
```

**Structure Decision**: Single package, CleanSlice vertical slices. The two new capabilities with their own state (rules, instincts) become `agent/` slices with the standard `domain/ data/ module index` layout; everything else is an extension of the slice that already owns the behaviour (prompt → `agent/agent`, selection → `agent/skill`, compaction → `agent/session`, workers → `agent/task`, enforcement → `runtime/loop`). No new top-level groups.

## Phase ordering (for /speckit-tasks)

Dependencies drive the order; each phase is shippable on its own and matches a spec priority.

1. **Foundation** — `Tool.effect` annotation on built-ins and MCP mapping; `agent.config.json` additions with defaults; `IPromptBreakdown` return from `buildSystemPrompt`. No behaviour change.
2. **US1 Guardrails** — `agent/guard` slice, baseline rules, loop interception, record file, `/rules`. Unlocks evidence for US3 and the `blocked` outcome for US5/US6.
3. **US2 Lean context** — budget accounting and `## Rules` exemption, `skill_load` + per-session retention, `tool_describe` + core/stub catalogue, `/context`, `agent_status.context`.
4. **US3 Teachable memory** — `agent/instinct` slice, retargeted review pass, prompt rendering by band, decay on heartbeat, `/learned` family, promotion via `skill_write`.
5. **US4 Compaction** — `inFlight`, reason, in-flight note, hard-limit gate, idle trigger, `/compact`.
6. **US5 Verification** — `VerificationService`, loop integration on mutating turns, timeout marker.
7. **US6 Delegation** — `DelegateService`, `delegate_task`, blocked set, completion contract in the loop.
8. **Evals** — `scripts/eval.ts` and the four eval sets; thresholds from SC-001/003/004/007 asserted in CI as a separate job.

Each phase: tests first (R15), one PR, one Jira ticket under CLEAN-150 as the epic/parent, roadmap items #4/#6/#10/#15 in `IMPROVEMENT_PLAN.md` marked as superseded by the corresponding phase.

## Complexity Tracking

No constitution violations to justify. Two deliberate scope limits, recorded so they are not mistaken for omissions:

| Limit | Why | Revisit when |
|---|---|---|
| Rule actions are declarative (`block`/`redact`/`record`), no script hooks | Shell-outs per tool call are the wrong primitive in a container agent; the declarative set covers the baseline and the spec's scenarios | A rule needs a check that cannot be expressed as glob + JSON-path + regex |
| Tool *schemas* still go to the provider every call; only the prose catalogue is budgeted | Schemas sit in the cached prefix; deferring them needs `ILlmGateway` changes across five providers | MCP integrations push the schema block past ~30 k tokens |
