import type { IAgentGateway } from "../domain/agent.gateway"
import type { AgentConfig } from "../domain/agent.types"
import type { MemoryLimits } from "../../memory/domain/memory.types"
import type { ICuratedBound } from "../../memory/domain/curatedBound"
import { boundCurated } from "../../memory/domain/curatedBound"
import { existsSync } from "fs"

export class AgentGateway implements IAgentGateway {
  /** Without limits every file is handed over whole (tests, tools that read the raw file). */
  constructor(private limits?: MemoryLimits) {}

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
    const [soulRaw, userRaw, memoryRaw, heartbeatRaw, agents] = await Promise.all([
      this.readIfExists(`${agentDir}/SOUL.md`),
      this.readIfExists(`${agentDir}/USER.md`),
      this.readIfExists(`${agentDir}/MEMORY.md`),
      this.readIfExists(`${agentDir}/HEARTBEAT.md`),
      this.readIfExists(`${agentDir}/AGENTS.md`),
    ])

    // The prompt gets a copy that fits memory.limits; the file on disk stays
    // whole (CLEAN-207). The numbers travel with the config so the prompt can
    // say what was left out.
    const curated: Record<string, ICuratedBound> = {}
    const fit = (file: string, content: string | undefined): string | undefined => {
      if (content === undefined || !this.limits) return content
      const bound = boundCurated(file, content, this.limits)
      curated[file] = bound
      return bound.text
    }
    const soul = fit("SOUL.md", soulRaw)
    const user = fit("USER.md", userRaw)
    const memory = fit("MEMORY.md", memoryRaw)
    const heartbeat = fit("HEARTBEAT.md", heartbeatRaw)

    // Skills are loaded separately via SkillModule and injected by RuntimeService.
    // Only descriptions go into the system prompt; full content loads on demand.
    return { soul, user, memory, heartbeat, agents, skills: [], curated }
  }
}
