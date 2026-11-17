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

  /** The skills a turn may read: all of them for an admin, the ones not marked `audience: admin` for anybody else (CLEAN-232). */
  visibleTo(isAdmin = false): Skill[] {
    return this.service.visibleTo(isAdmin)
  }

  get(name: string, isAdmin = false): Skill | undefined {
    return this.service.get(name, isAdmin)
  }

  summaries(isAdmin = false): SkillSummary[] {
    return this.service.summaries(isAdmin)
  }

  select(message: string, isAdmin = false): Skill | null {
    return this.service.select(message, isAdmin)
  }

  // ─── Per-session on-demand loading ────────────────────────────────────────

  nextTurn(sessionId: string): number {
    return this.service.nextTurn(sessionId)
  }

  markLoaded(sessionId: string, name: string, turn: number, isAdmin = false): LoadedSkillInfo {
    return this.service.markLoaded(sessionId, name, turn, isAdmin)
  }

  activeFor(sessionId: string, turn: number, isAdmin = false): Skill[] {
    return this.service.activeFor(sessionId, turn, isAdmin)
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
