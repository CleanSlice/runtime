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
    const [soul, user, memory, heartbeat, agents] = await Promise.all([
      this.readIfExists(`${agentDir}/SOUL.md`),
      this.readIfExists(`${agentDir}/USER.md`),
      this.readIfExists(`${agentDir}/MEMORY.md`),
      this.readIfExists(`${agentDir}/HEARTBEAT.md`),
      this.readIfExists(`${agentDir}/AGENTS.md`),
    ])

    const skills: string[] = []
    const skillsDir = `${agentDir}/skills`
    try {
      const glob = new Bun.Glob("**/*.md")
      for await (const file of glob.scan(skillsDir)) {
        const content = await Bun.file(`${skillsDir}/${file}`).text()
        skills.push(content)
      }
    } catch {
      // no skills dir
    }

    return { soul, user, memory, heartbeat, agents, skills }
  }
}
