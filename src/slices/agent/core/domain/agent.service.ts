import type { IAgentGateway } from "./agent.gateway"
import type { AgentConfig } from "./agent.types"

export class AgentService {
  constructor(private gateway: IAgentGateway) {}

  async load(agentDir: string): Promise<AgentConfig> {
    return this.gateway.load(agentDir)
  }

  buildSystemPrompt(config: AgentConfig, agentDir?: string): string {
    const parts: string[] = []
    if (config.soul)      parts.push(`# Soul\n\n${config.soul}`)
    if (config.agents)    parts.push(`# Agent Instructions\n\n${config.agents}`)
    if (config.user)      parts.push(`# User Context\n\n${config.user}`)
    if (config.memory)    parts.push(`# Memory\n\n${config.memory}`)
    if (config.heartbeat) parts.push(`# Heartbeat\n\n${config.heartbeat}`)
    for (const skill of config.skills) parts.push(`# Skill\n\n${skill}`)

    if (agentDir) {
      parts.push(`# Runtime\n\nAgent dir: ${agentDir}\nSkills dir: ${agentDir}/skills/\n\nTo create a skill, use the \`skill_write\` tool with name, description, and content. The skill will be immediately active.`)
    }

    parts.push(`# Context Recall Rules

When the user says "я кидал выше", "я скидав вище", "I sent you earlier", "see above", "ты уже знаешь", "я давал тебе" — DO NOT ask them to repeat.
Instead:
1. Search [ARCHIVED CONTEXT] blocks in the conversation history for the relevant value
2. Check memory/secrets if applicable
3. Only ask once, specifically, if the value is truly not found anywhere: "Не знайшов <X>, скинь ще раз"

NEVER say "you mentioned earlier but I don't have access to that" if there's an [ARCHIVED CONTEXT] block — search it first.`)

    return parts.join("\n\n---\n\n")
  }

  async buildPrompt(agentDir: string, userId?: string): Promise<string> {
    const config = await this.load(agentDir)

    // Override user context with per-user file if it exists
    // Looks for: .agent/users/{userId}.md
    if (userId) {
      const userFile = `${agentDir}/users/${userId}.md`
      try {
        const userContext = await Bun.file(userFile).text()
        if (userContext.trim()) config.user = userContext
      } catch {
        // No per-user file — use default USER.md
      }
    }

    return this.buildSystemPrompt(config, agentDir)
  }
}
