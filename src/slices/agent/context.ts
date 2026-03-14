import type { AgentConfig } from "./domain/Agent"

export function buildSystemPrompt(config: AgentConfig): string {
  const parts: string[] = []

  if (config.soul) {
    parts.push(`# Soul\n\n${config.soul}`)
  }

  if (config.user) {
    parts.push(`# User Context\n\n${config.user}`)
  }

  if (config.memory) {
    parts.push(`# Memory\n\n${config.memory}`)
  }

  if (config.heartbeat) {
    parts.push(`# Heartbeat\n\n${config.heartbeat}`)
  }

  for (const skill of config.skills) {
    parts.push(`# Skill\n\n${skill}`)
  }

  return parts.join("\n\n---\n\n")
}
