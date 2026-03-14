import type { AgentGateway } from "./agent.gateway"
import type { AgentConfig } from "./agent.types"

export class AgentService {
  constructor(private gateway: AgentGateway) {}

  async load(agentDir: string): Promise<AgentConfig> {
    return this.gateway.load(agentDir)
  }

  buildSystemPrompt(config: AgentConfig): string {
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
}
