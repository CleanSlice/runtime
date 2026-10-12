import type { SkillSummary } from "../../skill/domain/skill.types"

export interface AgentFile {
  path: string
  content: string
}

/** Named parts of the always-on system prompt, in the order they are emitted. */
export type PromptSectionName =
  | "soul" | "channel" | "hint" | "tooling" | "agents" | "user" | "integrator"
  | "memory" | "dailyNotes" | "heartbeat" | "skillsCatalog" | "credentials" | "runtime" | "silent"
  | "alwaysSkills" | "activeSkill" | "instincts"

export interface IPromptSection {
  name: PromptSectionName
  chars: number
}

/** What `buildSystemPrompt` returns: the text plus where its characters went. */
export interface IBuiltPrompt {
  prompt: string
  sections: IPromptSection[]
}

/** One on-demand load during a turn — a skill body or a tool description (CLEAN-150 US2). */
export interface IOnDemandLoad {
  kind: "skill" | "tool"
  name: string
  chars: number
}

/**
 * Per-turn accounting of the system prompt against `contextBudget`, kept by
 * the runtime per session and shown by `/context` and `agent_status`.
 */
export interface IPromptBreakdown {
  total: number
  budget: number
  sections: Array<IPromptSection & { budget?: number; over: boolean }>
  onDemand: IOnDemandLoad[]
}

export interface AgentConfig {
  soul?: string
  user?: string
  memory?: string
  heartbeat?: string
  agents?: string   // AGENTS.md — runtime instructions
  skills: SkillSummary[]
}
