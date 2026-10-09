# Feature Specification: Harness Principles for the Runtime Agent (adopted from ECC)

**Feature Branch**: `docs/CLEAN-150-ecc-agent-principles`

**Created**: 2026-10-08

**Status**: Draft

**Ticket**: [CLEAN-150](https://dreamvention.atlassian.net/browse/CLEAN-150)

**Input**: User description: "Пройдись еще раз по ECC и зафиксируй те паттерны, которые мы можем глобально перенять на нашу систему, ведь наш рантайм это агент, ему нужно правильный принципы, эффективные. Чтобы обучать модель еще проще"

## Context

The CleanSlice runtime is an agent harness: an agent is a folder of files (identity, user, memory, heartbeat, skills, data) that the runtime brings to life on chat channels with tools, sessions, cron and background work. ECC ([ecc.tools](https://ecc.tools), [affaan-m/ECC](https://github.com/affaan-m/ECC)) is a toolkit for a different kind of harness (coding agents: Claude Code, Codex, Cursor), but the principles it has converged on are harness-agnostic. Its slogan is "Optimize the context window. Persist everything else." and its loop is *plan → test → implement → review → verify → remember → improve*.

This specification fixes **which of those principles the runtime adopts globally** — for every agent built on it, not for one template — expressed as testable requirements. The goal the operator stated is simple: the agent should hold the right principles by default, run cheaply, and be **easier to teach**: a correction given once should stick, and the operator should be able to see what the agent has learned and why.

The patterns, in ECC's own terms, and what they become here:

| ECC principle | ECC mechanism | Adopted as |
|---|---|---|
| Hooks run outside the model, deterministically ("hooks fire 100% of the time; skills are probabilistic, 50–80%") | `PreToolUse` / `PostToolUse` / `Stop` hooks: config protection, secret guards, audit, format/typecheck | **Guardrails around every tool call** (US1) |
| Keep always-loaded context small; load skills lazily through a trigger table ("each loaded skill adds 1–5K tokens"; "<80 active tools") | Rules = always-loaded, skills = on demand, `/context-budget` | **Lean always-on context, knowledge on demand** (US2) |
| Learn from sessions as confidence-weighted instincts, not raw notes ("one trigger, one action", 0.3–0.9, evidence-backed, project-scoped, `/evolve`, `/promote`) | continuous-learning-v2 | **Teachable memory with confidence** (US3) |
| Compact at phase boundaries, never mid-implementation; save state to files first ("the hook tells you *when*, you decide *if*") | strategic-compact, pre-compact hook | **Compaction at task boundaries** (US4) |
| Verify before claiming done; a hook catches issues immediately, a verification pass reviews comprehensively | verification-loop, Stop hooks | **Verified completion** (US5) |
| Delegate only when work cannot fit one context; "your final message IS the deliverable"; "if you delegate, you own collection" | agents rule, completion contract | **Delegation with a completion contract** (US6) |

Out of scope: installing ECC itself (it is a Claude Code plugin, not a library), its 293 skills / 68 agents catalog, Memory Vault, Control Pane, AgentShield, GitHub App — these target a developer workstation, not a running chat agent. Also out of scope: ECC as a tool for the *team* developing the runtime (a separate, cheaper decision).

## User Scenarios & Testing *(mandatory)*

Actors: **operator** — the admin who configures and teaches an agent through its files and through chat; **end user** — anyone chatting with the agent; **runtime** — the harness itself.

### User Story 1 - Guardrails that fire every time (Priority: P1)

The operator declares rules that must hold no matter what the agent is asked or how it was prompted: secret files are never read or echoed, credentials never appear in replies or logs, destructive operations outside an allowed scope are stopped, oversized tool output is cut before it reaches the model, and every tool call is recorded. These rules are enforced by the runtime around each tool call — they do not depend on the agent remembering an instruction.

**Why this priority**: Today the only thing standing between a prompt-injected end user and the agent's secrets is text in the system prompt, which ECC's own data puts at 50–80% reliability. This is the one adoption that changes the safety class of every agent on the platform, and it is a prerequisite for US3 (observations) and US5 (post-checks).

**Independent Test**: Declare a rule "never read `data/secrets/`", then ask the agent in ten different ways (direct, roleplay, "for debugging", via a skill) to print a secret. Every attempt is blocked and recorded; the agent's reply says it was blocked rather than inventing content.

**Acceptance Scenarios**:

1. **Given** a *blocking* rule for a tool/argument pattern, **When** the agent calls that tool with a matching argument, **Then** the tool does not run, the agent receives a short reason, the attempt is recorded, and the end user is not shown raw internals.
2. **Given** a *transforming* rule (e.g. redact values that look like credentials in tool output), **When** a tool returns such a value, **Then** the model and the end user see the redacted form, and the record notes a redaction occurred.
3. **Given** a *recording* rule only, **When** any tool runs, **Then** a record exists with tool name, outcome (ok / error / blocked), duration and size — without any change to the agent's behaviour.
4. **Given** an operator-authored rule file with a syntax error, **When** the agent starts, **Then** the agent refuses to start tools until the rule is fixed (fail closed for guardrails), and the operator is told which rule and why.
5. **Given** a recording/observation rule whose handler fails at runtime, **When** a tool runs, **Then** the tool still runs (fail open for observers) and the failure is logged once, not on every call.
6. **Given** the platform ships baseline rules and an agent adds its own, **When** both apply, **Then** the stricter outcome wins (block > transform > record) and the agent cannot disable a platform baseline rule.

---

### User Story 2 - Lean always-on context, knowledge on demand (Priority: P1)

The agent's always-present instructions are short and consist of rules only. Reference material (API tables, recipes, tool lookups) lives in skills that are brought in when the conversation needs them, chosen by the agent from their descriptions — not by counting shared words. The tool catalogue the agent always sees is a compact list; full details for a tool are fetched when the agent decides to use it. The operator can see what the always-on context costs and what was loaded on demand in a given turn.

**Why this priority**: The admin agent's identity file is already being truncated at its size limit, which means rules at the end are silently dropped. Everything that follows (learning, verification) adds context; without a budget discipline it will not fit. ECC's lazy-loading claim is a ≥50% cut in baseline context.

**Independent Test**: Take the current admin agent. Move its reference tables into skills, keep only rules in the identity file. Run the existing eval set: pass rate is not lower, always-on context is at least 40% smaller, and in a turn about "knowledge indexes" the knowledge skill is loaded while unrelated skills are not.

**Acceptance Scenarios**:

1. **Given** an identity file over the size budget, **When** the agent starts, **Then** the operator is warned which sections overflow and nothing is silently cut from the *rules* portion.
2. **Given** skills with descriptions, **When** an end user asks something a skill covers in words that do not literally appear in the description, **Then** the skill is loaded for that turn and its instructions apply.
3. **Given** a skill marked always-on, **When** any turn runs, **Then** it is present; **Given** a skill marked on-demand, **When** no turn needs it, **Then** it costs only its one-line catalogue entry.
4. **Given** a skill declaring required binaries or environment variables that are missing, **When** it would be loaded, **Then** it is not loaded and the catalogue entry says why.
5. **Given** 60+ registered tools (built-in plus integrations), **When** the agent needs one, **Then** it can obtain the tool's full description on demand; the always-on catalogue stays within its budget regardless of tool count.
6. **Given** a turn finished, **When** the operator asks for the context breakdown, **Then** they see the size of each always-on section and which skills/tools were loaded on demand.

---

### User Story 3 - Teachable memory with confidence (Priority: P2)

When the operator corrects the agent, or the agent resolves an error, or a workflow repeats, the runtime records a *learned behaviour*: one trigger, one action, a confidence score, and the evidence it came from. Repetition without correction raises confidence; an explicit correction lowers it; a behaviour not seen for a long time decays. Only behaviours above an apply threshold shape the agent's actions; below it they are merely suggested; above a higher threshold they are treated as core. The operator can list learned behaviours with their scores and evidence, prune them, pin them, and promote a cluster into a reusable skill. Learned behaviours belong to the agent that learned them unless promoted.

**Why this priority**: This is the "easier to teach" goal. Today learned facts are appended as flat lines with deduplication only: nothing weakens a wrong lesson, nothing strengthens a right one, nothing is ever removed, and the operator cannot see why the agent behaves as it does. Depends on US1 for reliable observations.

**Independent Test**: Correct the agent once in chat ("don't restart agents without confirming"). In the next ten matching situations the agent asks for confirmation at least nine times. The operator lists learned behaviours and sees this one with its confidence and the quoting evidence; marks it core; it survives later memory maintenance.

**Acceptance Scenarios**:

1. **Given** the operator corrects the agent's behaviour in chat, **When** the turn ends, **Then** a learned behaviour exists with trigger, action, evidence pointing at that exchange, and a starting confidence that is below "core" but above "suggested".
2. **Given** a learned behaviour at apply level, **When** a matching situation recurs and the operator does not correct, **Then** its confidence rises; **When** the operator corrects it, **Then** its confidence falls and, if below apply level, it stops shaping actions.
3. **Given** a learned behaviour not reinforced for a configurable period, **When** maintenance runs, **Then** its confidence decays; pinned behaviours do not decay.
4. **Given** two learned behaviours that contradict each other, **When** both would apply, **Then** the higher-confidence one wins and the conflict is surfaced to the operator.
5. **Given** the operator asks what the agent has learned, **When** the list is shown, **Then** each entry shows trigger, action, confidence band, evidence count and last reinforcement, and the operator can prune, pin or promote it in one action.
6. **Given** several related learned behaviours, **When** the operator promotes them, **Then** a skill is produced for review (not auto-applied platform-wide), and the behaviours reference it.
7. **Given** the operator states a rule explicitly ("always …"), **When** it is recorded, **Then** it enters at core confidence immediately — teaching should not require repetition.

---

### User Story 4 - Compaction at task boundaries (Priority: P2)

The runtime shortens a long conversation at natural boundaries — when a task has finished, when the agent has been idle, after a failed approach is abandoned — and not in the middle of a task. Before shortening, durable facts are flushed to memory and the in-flight state (what was being done, what is pending) is written down so the next phase can continue. A hard size limit remains as the last resort.

**Why this priority**: Compaction today is triggered by size alone and can land mid-task, losing file paths, partial results and the user's stated preferences. ECC lists exactly these as what compaction loses and prescribes boundaries plus save-first. Lower than US1/US2 because the hard-limit path already protects correctness.

**Independent Test**: Run a multi-step task that crosses the size threshold mid-way. Compaction waits until the task completes; the summary names what was done and what is pending; a follow-up question about a detail from before compaction is answered correctly from memory or the saved state.

**Acceptance Scenarios**:

1. **Given** a session over its size budget and a task in flight, **When** the budget is exceeded, **Then** compaction is deferred until the task ends or the agent idles — unless the hard limit is reached, in which case it proceeds and the fact is recorded.
2. **Given** a compaction is about to run, **When** it starts, **Then** durable facts have been flushed and an in-flight note (goal, done, pending, open questions) is kept alongside the summary.
3. **Given** a task that ended in a failed approach, **When** the end user moves to something else, **Then** the dead-end reasoning is a candidate for compaction before the new work begins.
4. **Given** the operator inspects a session, **When** they look at its history, **Then** each compaction is visible as an event with its reason (task boundary / idle / hard limit).

---

### User Story 5 - Verified completion (Priority: P3)

When the agent has changed something in the world — run a command, written a file, called a mutating API, sent a message — it does not report success from intent. It checks the outcome (exit status, re-read, status call, response code) and the report quotes that check. If the check fails, the report says so verbatim. The runtime enforces this as a structural step, not as a line in the identity file.

**Why this priority**: "Never pretend. No tool call = no claim." is already a hard rule in the admin agent's identity, which means it has been violated enough to be written down. Making it structural (a post-check before the final answer) is ECC's "hooks catch issues immediately; the verification pass reviews comprehensively". Lower priority because it costs an extra model step per mutating turn.

**Independent Test**: Give the agent a task whose underlying API returns 500. The reply reports the failure with the status and body; it does not say "done".

**Acceptance Scenarios**:

1. **Given** a turn that executed at least one mutating tool, **When** the agent drafts a final reply claiming completion, **Then** the reply is checked against the tool outcomes, and a claim unsupported by a successful outcome is rewritten to report what actually happened.
2. **Given** a mutating tool returned an error, **When** the agent replies, **Then** the error is quoted (status and message) and no success is claimed.
3. **Given** a read-only turn, **When** it ends, **Then** no verification step is added (no extra cost).
4. **Given** the verification step itself fails or times out, **When** the reply is sent, **Then** the original reply goes out with a note that it was not verified — verification never blocks delivery indefinitely.

---

### User Story 6 - Delegation with a completion contract (Priority: P3)

The agent can hand a sub-task to a worker with a fresh context and a restricted set of tools (no further delegation, no memory writes, no messaging). Independent sub-tasks run in parallel. The parent owns collection: it never ends its turn while workers are running, and its final message carries the workers' results. Delegation happens only when the work cannot fit in one context.

**Why this priority**: Isolated workers are the standard way to keep the main context lean on big tasks and are already planned (`delegate_task`). ECC adds the part the plan lacks: the completion contract and the anti-patterns (fire-and-forget, sequential when independent, ending with "waiting").

**Independent Test**: Ask for a report over five agents. The parent fans out five workers in parallel, waits, and replies with one consolidated result; no worker can send messages or write memory; the parent's reply is the deliverable.

**Acceptance Scenarios**:

1. **Given** a delegated sub-task, **When** the worker runs, **Then** it cannot delegate further, write long-term memory, or message end users; it returns a summary only.
2. **Given** several independent sub-tasks, **When** delegated, **Then** they run concurrently and the parent waits for all before replying.
3. **Given** a worker still running, **When** the parent would otherwise end its turn, **Then** it does not; it either waits or cancels the worker and says so.
4. **Given** a sub-task that fits in the parent's context, **When** the agent considers delegating, **Then** it does the work directly (delegation is justified, not default).

---

### Edge Cases

- A guardrail rule and a learned behaviour disagree (the agent learned "it's fine to print the token for the operator"): guardrails always win; learned behaviours can never relax a rule.
- A platform baseline rule blocks something an operator legitimately needs: the operator sees which rule blocked and can request a platform change; they cannot override locally.
- The identity file is managed by the platform (template) and also edited locally: budget warnings name the source file so the fix goes to the right place.
- A skill is loaded on demand in turn N but the conversation continues to rely on it in turn N+1: it stays loaded while the topic persists and is released when unused for a configurable number of turns.
- Confidence never rises because the behaviour is correct and unremarkable (no correction, but also no repeated observation): "not corrected while applied" counts as reinforcement.
- Two operators teach contradictory rules to the same agent: both are recorded with their evidence; the newer explicit rule wins; the conflict is surfaced.
- Compaction is deferred but the task never ends (a long heartbeat loop): the hard limit triggers compaction regardless, with the in-flight note saved.
- Verification would itself need a mutating tool (e.g. re-sending a message to check delivery): verification is restricted to read-only checks; if none exists, the reply states the outcome is unverified.
- A worker exceeds its time budget: the parent cancels it, reports partial results, and does not claim completeness.

## Requirements *(mandatory)*

### Functional Requirements

**Guardrails (US1)**

- **FR-001**: The runtime MUST evaluate operator- and platform-declared rules before and after every tool call, independent of prompt content.
- **FR-002**: A rule MUST be able to *block* a call, *transform* a call's arguments or result, or *record* the call; outcomes compose with block > transform > record.
- **FR-003**: Rules MUST be declared as files inside the agent's folder (agent-level) and shipped with the platform (baseline); agent-level rules MUST NOT disable baseline rules.
- **FR-004**: Guardrail (block/transform) rules MUST fail closed: an invalid rule prevents tool use and the operator is told why. Observer (record) rules MUST fail open and MUST NOT delay a tool call beyond a bounded time.
- **FR-005**: Baseline rules MUST at minimum: block reading or listing the agent's secret store through generic file/shell tools; redact credential-shaped values in tool results and outgoing messages; cap tool result size; record every tool call with name, outcome, duration and size.
- **FR-006**: When a call is blocked, the agent MUST receive a short reason it can relay, and the end user MUST NOT receive raw rule internals or the blocked content.

**Lean context (US2)**

- **FR-007**: The runtime MUST define a size budget for the always-on context and report per-section sizes to the operator on demand and on start-up when exceeded.
- **FR-008**: Rules in the identity file MUST never be silently truncated; overflow MUST be reported and MUST drop reference material before rules.
- **FR-009**: Skills MUST be loadable on demand for a turn, selected by the agent from skill descriptions, and released when unused for a configurable number of turns; skills marked always-on MUST be present every turn.
- **FR-010**: A skill MUST be able to declare required binaries and environment variables; an unsatisfiable skill MUST NOT be loaded and its catalogue entry MUST state the missing requirement.
- **FR-011**: The always-on tool catalogue MUST stay within its budget regardless of the number of registered tools; full tool descriptions MUST be obtainable on demand.
- **FR-012**: Per turn, the runtime MUST be able to report what was loaded on demand (skills, tool details) and its size.

**Teachable memory (US3)**

- **FR-013**: The runtime MUST record learned behaviours as *trigger, action, confidence, evidence, scope, source, last-reinforced*.
- **FR-014**: Confidence MUST increase on uncorrected reinforcement, decrease on explicit correction, and decay when not reinforced for a configurable period; pinned behaviours MUST NOT decay.
- **FR-015**: Three thresholds MUST govern use: below *apply* a behaviour is only suggested to the agent; at or above *apply* it shapes actions; at or above *core* it is treated as a standing rule. Explicit operator rules MUST enter at core.
- **FR-016**: Learned behaviours MUST NOT be able to relax a guardrail rule.
- **FR-017**: The operator MUST be able to list, inspect (with evidence), pin, prune and promote learned behaviours through the chat interface; promotion MUST produce a skill for review, not an automatic platform-wide change.
- **FR-018**: Learned behaviours MUST be scoped to the agent that learned them; sharing across agents MUST be an explicit operator action.
- **FR-019**: Contradicting behaviours MUST resolve to the higher confidence and MUST be surfaced to the operator.
- **FR-020**: Only learned behaviours (not raw observations or transcripts) MAY be exported or promoted.

**Compaction (US4)**

- **FR-021**: Compaction MUST prefer task boundaries and idle periods; it MUST NOT start while a task is in flight unless a hard size limit is reached.
- **FR-022**: Before any compaction, durable facts MUST be flushed to memory and an in-flight note (goal, done, pending, open questions) MUST be retained with the summary.
- **FR-023**: Each compaction MUST be recorded as a session event with its reason.

**Verified completion (US5)**

- **FR-024**: When a turn executed a mutating tool, the runtime MUST check the agent's completion claims against tool outcomes before delivery and MUST rewrite unsupported claims into a factual report.
- **FR-025**: Errors from mutating tools MUST be reported with status and message; success MUST NOT be claimed.
- **FR-026**: Verification MUST be skipped for read-only turns and MUST be bounded in time; on timeout the reply is delivered marked unverified.

**Delegation (US6)**

- **FR-027**: Delegated workers MUST run with fresh context and a restricted toolset (no delegation, no long-term memory writes, no end-user messaging) and MUST return a summary only.
- **FR-028**: Independent delegated sub-tasks MUST run concurrently.
- **FR-029**: A parent MUST NOT end its turn while its workers run; it MUST either wait or cancel and report.
- **FR-030**: Worker time budgets MUST be enforced; on expiry the parent reports partial results without claiming completeness.

### Key Entities

- **Rule**: a declared guardrail — *event* (before/after a tool call), *matcher* (tool, argument or result pattern), *action* (block / transform / record), *blocking* flag, *source* (platform baseline / agent). Composes by strictest outcome.
- **Tool-call record**: one line per call — tool, outcome, duration, sizes, which rules fired. Source of evidence for learning and of audit for the operator.
- **Learned behaviour**: trigger, action, confidence (0–1 with *suggested* / *apply* / *core* bands), evidence (references to exchanges or records), scope (this agent / shared), source (correction / error-resolution / repetition / explicit rule), pinned flag, last-reinforced.
- **Skill**: name, description (states *when* to use), always-on flag, requirements (binaries, environment), body. Loaded on demand or always.
- **Context budget**: a total and per-section allowance for the always-on prompt; actuals per turn including on-demand loads.
- **Compaction checkpoint**: reason (boundary / idle / hard limit), the in-flight note, the summary.
- **Delegated worker**: a sub-task with its own context, allowed tools, time budget and result summary.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Against an adversarial set of at least 30 prompts that try to extract secrets or perform disallowed actions, 100% are blocked by rules — zero depend on the agent "remembering" an instruction.
- **SC-002**: The always-on context of the admin agent shrinks by at least 40% while the existing evaluation set passes at the same or higher rate; the identity file is no longer truncated.
- **SC-003**: On an evaluation set of 100 messages, the right skill is loaded in at least 90% of cases where one applies, and an unrelated skill is loaded in at most 5% of cases (baseline today: keyword overlap of two or more words).
- **SC-004**: A correction given once in chat changes the agent's behaviour in at least 9 of the next 10 matching situations for that agent, and the operator can see the learned behaviour with its evidence within one turn of asking.
- **SC-005**: Learned memory stays bounded: behaviours not reinforced for the configured period fall below the apply threshold on their own; the operator can prune in one action; no learned behaviour ever relaxes a rule (0 cases in evaluation).
- **SC-006**: In evaluation sessions that cross the size threshold mid-task, 0 compactions begin before the task ends (hard limit excepted), and follow-up questions about pre-compaction details are answered correctly in at least 90% of cases.
- **SC-007**: Findings of "claimed done but was not" in evaluation drop by at least 50% against the current baseline, with no increase in reply latency for read-only turns.
- **SC-008**: Delegated fan-out tasks finish with one consolidated reply in 100% of evaluation runs; 0 runs end with workers still running or results dropped.
- **SC-009**: The operator can answer "what does this agent always carry, what did it load for this turn, and what has it learned" from chat without opening files.

## Assumptions

- The operator is the agent's admin, reached through the chat channel and through the agent's files; teaching happens primarily in chat, configuration primarily in files.
- "Globally" means every agent built on the runtime gets the baseline (rules, budgets, learning, compaction policy) with per-agent additions; nothing in this spec is specific to one template.
- Learned behaviours above the apply threshold take effect without operator approval (ECC's default: 0.7 "auto-approved for application"); approval is required only for promotion into a skill or for sharing across agents. If the operator wants approval before any learned behaviour applies, that is a single policy switch, not a redesign.
- Background work (learning analysis, verification, compaction summaries) uses the cheaper auxiliary model, as compaction and memory flush already do.
- Observations used for learning stay inside the agent's folder; nothing is sent elsewhere unless the operator exports it.
- Baseline rules are maintained by the platform team; agents cannot weaken them. The first baseline covers secrets, credential redaction, output size and audit — not a full URL/path allow-list (that remains a planned safety pipeline item).
- Delegation builds on the planned in-runtime `delegate_task`, not on shelling out to an external coding agent.
- Existing roadmap items this spec sharpens rather than duplicates: safety pipeline (#10), lifecycle hooks (#15), curator (#4), subagent delegation (#6) in `IMPROVEMENT_PLAN.md`. Their ordering should follow the priorities here: guardrails and context budget first.
- The runtime runs in containers on Linux; operator tooling on Windows is not a target for these behaviours.
- ECC content is adapted, not installed: ECC skill files happen to share our skill format and may be imported individually where useful, but no ECC component becomes a runtime dependency.
