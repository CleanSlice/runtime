import type { IAgentGateway } from "../domain/agent.gateway"
import type { AgentConfig } from "../domain/agent.types"
import { existsSync } from "fs"

/** Same text whatever the line endings and the trailing whitespace. */
function sameText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n/g, "\n").trim()
  return norm(a) === norm(b)
}

export class AgentGateway implements IAgentGateway {
  /**
   * `exampleDir` is `.agent.example`: a curated file that still reads exactly
   * as it shipped there is a placeholder ("Name: Unknown", an empty task
   * list), not knowledge, and stays out of the prompt until someone edits it
   * (CLEAN-213). Deleting such a file does not help — the scaffold recreates
   * it on the next start — so the comparison is the only way to leave it out.
   */
  constructor(private exampleDir?: string) {}

  private async readIfExists(path: string): Promise<string | undefined> {
    try {
      if (!existsSync(path)) return undefined
      return await Bun.file(path).text()
    } catch {
      return undefined
    }
  }

  private async unlessExample(name: string, content: string | undefined): Promise<string | undefined> {
    if (content === undefined || !this.exampleDir) return content
    const example = await this.readIfExists(`${this.exampleDir}/${name}`)
    return example !== undefined && sameText(content, example) ? undefined : content
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
      this.unlessExample("USER.md", await this.readIfExists(`${agentDir}/USER.md`)),
      this.unlessExample("MEMORY.md", await this.readIfExists(`${agentDir}/MEMORY.md`)),
      this.unlessExample("HEARTBEAT.md", await this.readIfExists(`${agentDir}/HEARTBEAT.md`)),
      this.readIfExists(`${agentDir}/AGENTS.md`),
    ])
    // Skills are loaded separately via SkillModule and injected by RuntimeService.
    // Only descriptions go into the system prompt; full content loads on demand.
    return { soul, user, memory, heartbeat, agents, skills: [] }
  }
}
