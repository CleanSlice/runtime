export type InstinctSource = "correction" | "error-resolution" | "repetition" | "explicit-rule"
export type InstinctBand = "hidden" | "suggested" | "apply" | "core"
export type InstinctScope = "agent" | "shared"

export interface IEvidence {
  /** `session:<sessionId>#<eventId>` or `toolcall:<ts>:<turnId>`. */
  ref: string
  ts: number
  note?: string
}

/**
 * One learned behaviour (CLEAN-150 US3): a trigger, an action, and a
 * confidence that moves with experience. Persisted as one markdown file per
 * behaviour under `.agent/memory/instincts/`.
 */
export interface IInstinct {
  id: string
  trigger: string
  action: string
  confidence: number
  scope: InstinctScope
  source: InstinctSource
  pinned: boolean
  evidence: IEvidence[]
  created: number
  reinforced: number
  /** Set when a skill was produced from this instinct (`/learned promote`). */
  promotedTo?: string
  /** Set when a higher-confidence instinct contradicts this one; excluded from the prompt while set. */
  conflictsWith?: string
}

/**
 * Tuning. Confidence runs 0.1–0.95; the three bands decide what a behaviour
 * may do: below `suggested` it is invisible, from `suggested` it is listed
 * for the operator only, from `apply` it shapes the agent's actions, from
 * `core` it reads as a standing rule.
 */
export interface IInstinctConfig {
  enabled: boolean
  bands: { suggested: number; apply: number; core: number }
  /** Starting confidence per source. Explicit operator rules start pinned at `explicitRule`. */
  start: { correction: number; errorResolution: number; repetition: number; explicitRule: number }
  /** Added on each uncorrected application. */
  reinforce: number
  /** Subtracted on an explicit correction. */
  correct: number
  /** Subtracted per `decayDays` without reinforcement (pinned behaviours exempt). */
  decay: number
  decayDays: number
  /** Most behaviours rendered into the prompt, highest confidence first. */
  maxInjected: number
}

export const DEFAULT_INSTINCT_CONFIG: IInstinctConfig = {
  enabled: true,
  bands: { suggested: 0.3, apply: 0.5, core: 0.8 },
  start: { correction: 0.6, errorResolution: 0.5, repetition: 0.5, explicitRule: 0.9 },
  reinforce: 0.05,
  correct: 0.2,
  decay: 0.05,
  decayDays: 14,
  maxInjected: 8,
}

export const CONFIDENCE_MIN = 0.1
export const CONFIDENCE_MAX = 0.95

/** What a review pass asks the service to do with the conversation it saw. */
export type ReviewItem =
  | { kind: "new"; trigger: string; action: string; source: InstinctSource; evidence: IEvidence[]; conflictsWith?: string }
  | { kind: "reinforce"; id: string; evidence?: IEvidence }
  | { kind: "correct"; id: string; evidence?: IEvidence }

export interface IInstinctSummary {
  core: number
  apply: number
  suggested: number
  hidden: number
  conflicts: number
  pinned: number
}
