import type { SkillSummary } from "../../skill/domain/skill.types"

export interface AgentFile {
  path: string
  content: string
}

export interface AgentConfig {
  soul?: string
  user?: string
  memory?: string
  heartbeat?: string
  agents?: string   // AGENTS.md — runtime instructions
  skills: SkillSummary[]
}
