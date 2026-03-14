import type { IAgentGateway } from "../domain/agent.gateway"
import type { AgentConfig } from "../domain/agent.types"
import { existsSync } from "fs"

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    if (!existsSync(path)) return undefined
    return await Bun.file(path).text()
  } catch {
    return undefined
  }
}

export class FileAgentGateway implements IAgentGateway {
  async load(agentDir: string): Promise<AgentConfig> {
    const [soul, user, memory, heartbeat] = await Promise.all([
      readIfExists(`${agentDir}/SOUL.md`),
      readIfExists(`${agentDir}/USER.md`),
      readIfExists(`${agentDir}/MEMORY.md`),
      readIfExists(`${agentDir}/HEARTBEAT.md`),
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

    return { soul, user, memory, heartbeat, skills }
  }
}
