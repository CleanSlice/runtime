# Quickstart Results: Harness Principles for the Runtime Agent

**Run**: 2026-10-12 · branch stack `docs/CLEAN-150-ecc-agent-principles` → … → `chore/CLEAN-158-harness-polish`
**Method**: every scenario in [quickstart.md](../quickstart.md) is covered by an automated spec or a live-model eval where the behaviour is deterministic enough to assert; steps that need a running channel (Telegram / bridle) are listed as manual and were **not** run in this pass.

Marker semantics: `[x]` = verified by an automated check that passed; `[ ]` = manual step still to run against a dev agent.

## US1 — Guardrails

- [x] Ten different attempts to read `data/secrets/` are blocked and recorded — `tests/evals/guardrails.jsonl` 31/31 (`bun run eval`), `loop.service.spec.ts` "a blocked call never reaches the tool"
- [x] Token-shaped string in a tool result reaches the model and the transcript redacted — `loop.service.spec.ts` (two specs)
- [x] Streamed replies redact with hold-back — `guard.service.spec.ts` "redactStreaming"
- [x] Malformed rule file → load refused naming file and field, previous set kept — `guard.service.spec.ts` "GuardService.load"
- [ ] `/rules reload` reply text and start-up log on a live agent — manual

## US2 — Lean context

- [x] `## Rules` survives truncation, reference material goes first, `over` reported — `file.repository.spec.ts`
- [x] Skill loaded by the model for a message without the skill's keywords — `tests/evals/skill-selection.jsonl` 96/100 live, 0 false loads over the 5 % cap
- [x] Loaded skill body enters history ahead of the conversation, system prompt untouched — `loop.service.spec.ts` "on-demand skills"
- [x] Unsatisfiable skill listed as unavailable and refused — `skill.service.spec.ts`
- [x] Catalogue stubs + `tool_describe` — `tool.service.spec.ts`
- [ ] `/context` output and the ≥ 40 % shrink of the ranch admin agent — manual; the admin `SOUL.md` lives in the platform template (ranch-side follow-up noted on PR #27)

## US3 — Teachable memory

- [x] Explicit admin rule enters pinned at core; correction at 0.6 — `instinct.service.spec.ts`, `memory.service.spec.ts`
- [x] One correction holds on the next matching messages — `tests/evals/corrections.jsonl` 13/13 live
- [x] Decay, pin exemption, prune candidates, conflicts, promotion — `instinct.service.spec.ts`
- [x] Visitor sessions teach nothing — `memory.service.spec.ts`
- [x] A learned behaviour never relaxes a rule — by construction (instincts render into the prompt only; `guard` never reads them); `loop.service.spec.ts` blocked-call spec runs with no instinct path into the guard
- [ ] `/learned`, `/learned promote` output on a live agent — manual

## US4 — Compaction at boundaries

- [x] Deferred while a task is in flight below the hard limit; proceeds as `hard-limit` above it — `compaction.service.spec.ts`
- [x] `reason` and in-flight note on the summary event; `operator` bypasses thresholds — `compaction.service.spec.ts`
- [x] Idle sweep compacts idle, over-threshold, not-in-flight sessions only — `session.module.spec.ts`
- [ ] `/compact` reply and a follow-up question answered from the archive — manual

## US5 — Verified completion

- [x] False "done" after a failed mutating tool is rewritten before delivery — `loop.service.spec.ts` "verified completion"; `tests/evals/completion-claims.jsonl` 12/12 live
- [x] Read-only turn never calls the verifier — `loop.service.spec.ts`
- [x] Timeout delivers the draft with `(unverified)` — `loop.service.spec.ts`, `verification.service.spec.ts`

## US6 — Delegation

- [x] Workers: fresh history, parent identity, blocked tools filtered, `parentTaskId`, concurrency bound, timeout → cancelled with partial output — `delegate.service.spec.ts`
- [x] Parent turn does not end while a worker runs; past the budget it is cancelled and reported — `loop.service.spec.ts` "completion contract"
- [ ] Five-agent fan-out on a live agent with `/tasks` indentation — manual

## Regression

- `bun test`: 305 pass, 1 pre-existing Windows-only failure (`telegramFile > file lands under data/channels/`, path separator; green on Linux CI)
- `bun run eval`: guardrails 100 % · skill-selection 96 % · corrections 100 % · completion-claims 100 %
- `tsc --noEmit`: clean apart from the pre-existing `bridleAttachments.spec.ts` errors

## Open

- Manual scenarios above need a dev agent with a channel; none of them changes the code paths the automated checks cover.
- The ranch admin agent's `SOUL.md` reorganisation (endpoint table → `ranch` skill) is a platform-template change, outside this repository.
