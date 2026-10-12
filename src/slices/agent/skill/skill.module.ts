import type { Skill, RegistryEntry, SkillSummary, SkillServiceOptions, LoadedSkillInfo } from "./domain/skill.types"
import { SkillService } from "./domain/skill.service"
import { SkillGateway } from "./data/skill.gateway"

export type { SkillSummary, SkillSelection, LoadedSkillInfo } from "./domain/skill.types"

export class SkillModule {
  private service: SkillService

  constructor(agentDir: string, opts: Partial<SkillServiceOptions> = {}, bundledDir?: string) {
    this.service = new SkillService(new SkillGateway(agentDir, bundledDir), opts)
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

  summaries(): SkillSummary[] {
    return this.service.summaries()
  }

  select(message: string): Skill | null {
    return this.service.select(message)
  }

  // ─── Per-session on-demand loading ────────────────────────────────────────

  nextTurn(sessionId: string): number {
    return this.service.nextTurn(sessionId)
  }

  markLoaded(sessionId: string, name: string, turn: number): LoadedSkillInfo {
    return this.service.markLoaded(sessionId, name, turn)
  }

  activeFor(sessionId: string, turn: number): Skill[] {
    return this.service.activeFor(sessionId, turn)
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
