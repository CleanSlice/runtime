import type { ToolEffect } from "../../tool/domain/tool.types"

export type RuleEvent = "before" | "after"
export type RuleAction = "block" | "redact" | "record"
export type RuleSource = "baseline" | "agent"

export interface IRuleMatch {
  /** Tool name glob: `exec`, `exec|file`, `ranch__*`, `*`. */
  tool: string
  /** Before-call only: a JSON path into the params (`$`, `$.method`) and a regex over its value. */
  arg?: { path: string; pattern: string }
  /** After-call only: a regex over the serialized result. */
  result?: string
}

/**
 * One guardrail. Baseline rules ship with the runtime and may be
 * `protected` (an agent rule with the same id is refused); agent rules come
 * from `.agent/rules/*.md`. The markdown body is the reason the agent is
 * shown when the rule fires.
 */
export interface IRule {
  id: string
  event: RuleEvent
  match: IRuleMatch
  action: RuleAction
  enabled: boolean
  protected: boolean
  source: RuleSource
  reason: string
  file: string
}

/** A rule file as read from disk, before validation. `error` is a frontmatter parse failure. */
export interface IRuleFile {
  file: string
  source: RuleSource
  data: Record<string, unknown>
  body: string
  error?: string
}

/** What the guard knows about one tool call. */
export interface IGuardCall {
  tool: string
  params: unknown
  agentDir: string
  sessionId: string
  turnId: string
  effect: ToolEffect
}

export type CallOutcome = "ok" | "error" | "blocked" | "timeout"

/** One line of `data/toolcalls.jsonl` — the evidence trail for audit and learning. */
export interface IToolCallRecord {
  ts: number
  sessionId: string
  turnId: string
  tool: string
  outcome: CallOutcome
  durationMs: number
  paramsChars: number
  resultChars: number
  rulesFired: string[]
  redacted: boolean
  effect: ToolEffect
}

export type IBeforeVerdict =
  | { kind: "allow"; params: unknown; rulesFired: string[] }
  | { kind: "block"; ruleId: string; reason: string }

export interface IAfterMeta {
  outcome: CallOutcome
  durationMs: number
  /** Rules that already fired on the before side (block or redact), so the record is complete. */
  rulesFired: string[]
}

export interface IAfterVerdict {
  result: unknown
  redacted: boolean
  rulesFired: string[]
}

export interface IRuleFiringCount {
  id: string
  times: number
}
