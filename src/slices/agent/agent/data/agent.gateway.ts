import type { IAgentGateway } from "../domain/agent.gateway"
import type { AgentConfig } from "../domain/agent.types"
import { existsSync } from "fs"

export class AgentGateway implements IAgentGateway {
  private async readIfExists(path: string): Promise<string | undefined> {
    try {
      if (!existsSync(path)) return undefined
      return await Bun.file(path).text()
    } catch {
      return undefined
    }
  }

  async loadUserContext(agentDir: string, userId: string): Promise<string | undefined> {
    const userFile = `${agentDir}/users/${userId}.md`
    return this.readIfExists(userFile)
  }

  async load(agentDir: string): Promise<AgentConfig> {
    // The files come back whole, admin-only blocks and all; the prompt builder
    // strips what the audience may not see and only then bounds the copy to
    // memory.limits (CLEAN-207), so a cut can never leave a block half open.
    const [soul, user, memory, heartbeat, agents] = await Promise.all([
      this.readIfExists(`${agentDir}/SOUL.md`),
      this.readIfExists(`${agentDir}/USER.md`),
      this.readIfExists(`${agentDir}/MEMORY.md`),
      this.readIfExists(`${agentDir}/HEARTBEAT.md`),
      this.readIfExists(`${agentDir}/AGENTS.md`),
    ])

    // Skills are loaded separately via SkillModule and injected by RuntimeService.
    // Only descriptions go into the system prompt; full content loads on demand.
    return { soul, user, memory, heartbeat, agents, skills: [] }
  }
}
