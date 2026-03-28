import type { Skill, RegistryEntry } from "./skill.types"
import type { ISkillGateway } from "./skill.gateway"

export class SkillService {
  private skills: Skill[] = []

  constructor(private gateway: ISkillGateway) {}

  async load(): Promise<void> {
    this.skills = await this.gateway.loadAll()
  }

  getAll(): Skill[] {
    return this.skills
  }

  get(name: string): Skill | undefined {
    return this.skills.find(s => s.name === name)
  }

  /**
   * Select the most relevant skill for a given message.
   * Matches keywords from skill description against message words.
   * Returns null if no skill has sufficient overlap.
   */
  select(message: string): Skill | null {
    if (this.skills.length === 0) return null

    const words = message.toLowerCase().split(/\W+/).filter(w => w.length > 3)
    if (words.length === 0) return null

    let best: Skill | null = null
    let bestScore = 0

    for (const skill of this.skills) {
      const descWords = skill.description.toLowerCase().split(/\W+/).filter(w => w.length > 3)
      const score = words.filter(w => descWords.includes(w)).length
      if (score > bestScore) {
        bestScore = score
        best = skill
      }
    }

    // Require at least 2 matching keywords to activate a skill
    return bestScore >= 2 ? best : null
  }

  // ─── Install / Remove ────────────────────────────────────────────────────────

  async install(nameOrUrl: string): Promise<Skill> {
    const skill = await this.gateway.install(nameOrUrl)
    // Reload to include the new skill
    await this.load()
    return skill
  }

  async remove(name: string): Promise<void> {
    await this.gateway.remove(name)
    await this.load()
  }

  // ─── Registry ────────────────────────────────────────────────────────────────

  async searchRegistry(query: string): Promise<RegistryEntry[]> {
    return this.gateway.searchRegistry(query)
  }

  async fetchRegistry(): Promise<RegistryEntry[]> {
    return this.gateway.fetchRegistry()
  }
}
