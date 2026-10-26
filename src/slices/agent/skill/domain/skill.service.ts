import type { Skill, RegistryEntry, SkillSummary, SkillServiceOptions, LoadedSkillInfo } from "./skill.types"
import type { ISkillGateway } from "./skill.gateway"

const DEFAULT_OPTIONS: SkillServiceOptions = {
  selection: "model",
  retainTurns: 3,
  env: process.env,
  hasBin: (bin) => Bun.which(bin) !== null,
}

/** Per-session record of a skill the model pulled in. */
interface ILoadedSkill {
  name: string
  lastUsedTurn: number
}

export class SkillService {
  private skills: Skill[] = []
  private opts: SkillServiceOptions
  /** sessionId → skills loaded on demand, with the turn they were last used. */
  private loaded = new Map<string, ILoadedSkill[]>()
  /** sessionId → number of turns started. */
  private turns = new Map<string, number>()

  constructor(private gateway: ISkillGateway, opts: Partial<SkillServiceOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts }
  }

  async load(): Promise<void> {
    this.skills = await this.gateway.loadAll()
  }

  getAll(): Skill[] {
    return this.skills
  }

  get(name: string): Skill | undefined {
    return this.skills.find(s => s.name === name)
  }

  /** Catalogue entries for the system prompt, with the reason when a skill cannot be loaded. */
  summaries(): SkillSummary[] {
    return this.skills.map(s => {
      const a = this.availability(s)
      return { name: s.name, description: s.description, metadata: s.metadata, ...(a.ok ? {} : { unavailable: a.reason }) }
    })
  }

  /** Whether `requires.env` / `requires.bins` are satisfied, and the first thing missing if not. */
  availability(skill: Skill): { ok: true } | { ok: false; reason: string } {
    const req = skill.metadata?.requires
    for (const name of req?.env ?? []) {
      if (!this.opts.env[name]) return { ok: false, reason: `missing env ${name}` }
    }
    for (const bin of req?.bins ?? []) {
      if (!this.opts.hasBin(bin)) return { ok: false, reason: `missing binary ${bin}` }
    }
    return { ok: true }
  }

  // ─── Per-session on-demand loading (CLEAN-150 US2) ────────────────────────────

  /** Count one more turn for the session and return its number. */
  nextTurn(sessionId: string): number {
    const n = (this.turns.get(sessionId) ?? 0) + 1
    this.turns.set(sessionId, n)
    return n
  }

  /** The model pulled a skill in: remember it for `retainTurns` turns. Throws on unknown or unavailable skills. */
  markLoaded(sessionId: string, name: string, turn: number): LoadedSkillInfo {
    const skill = this.get(name)
    if (!skill) throw new Error(`unknown skill: ${name}`)
    const a = this.availability(skill)
    if (!a.ok) throw new Error(`skill unavailable: ${a.reason}`)
    const list = this.loaded.get(sessionId) ?? []
    const existing = list.find(l => l.name === name)
    if (existing) existing.lastUsedTurn = turn
    else list.push({ name, lastUsedTurn: turn })
    this.loaded.set(sessionId, list)
    return { name, chars: skill.content.length, retainedForTurns: this.opts.retainTurns }
  }

  /** Skills still active for a session at `turn`; expired ones are released here. */
  activeFor(sessionId: string, turn: number): Skill[] {
    const list = this.loaded.get(sessionId) ?? []
    // Loaded at turn N → still active through turn N + retainTurns.
    const kept = list.filter(l => turn - l.lastUsedTurn <= this.opts.retainTurns)
    if (kept.length !== list.length) this.loaded.set(sessionId, kept)
    return kept.map(l => this.get(l.name)).filter((s): s is Skill => !!s)
  }

  /**
   * Legacy keyword selection — only under `skills.selection: "keyword"`.
   * Under `model` the agent pulls skills itself with `skill_load`, so this
   * returns null and the catalogue is the only thing in the prompt.
   */
  select(message: string): Skill | null {
    if (this.opts.selection !== "keyword") return null
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
