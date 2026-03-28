import type { Skill, RegistryEntry } from "./domain/skill.types"
import { SkillService } from "./domain/skill.service"
import { SkillGateway } from "./data/skill.gateway"

export class SkillModule {
  private service: SkillService

  constructor(agentDir: string, bundledDir?: string) {
    this.service = new SkillService(new SkillGateway(agentDir, bundledDir))
  }

  async load(): Promise<void> {
    await this.service.load()
  }

  /** Hot-reload all skills from disk without restarting the bot */
  async reload(): Promise<Skill[]> {
    await this.service.load()
    return this.service.getAll()
  }

  getAll(): Skill[] {
    return this.service.getAll()
  }

  get(name: string): Skill | undefined {
    return this.service.get(name)
  }

  select(message: string): Skill | null {
    return this.service.select(message)
  }

  // ─── Install / Remove ──────────────────────────────────────────────────────

  async install(nameOrUrl: string): Promise<Skill> {
    return this.service.install(nameOrUrl)
  }

  async remove(name: string): Promise<void> {
    return this.service.remove(name)
  }

  // ─── Registry ──────────────────────────────────────────────────────────────

  async searchRegistry(query: string): Promise<RegistryEntry[]> {
    return this.service.searchRegistry(query)
  }

  async fetchRegistry(): Promise<RegistryEntry[]> {
    return this.service.fetchRegistry()
  }
}
