import type { Skill, RegistryEntry, SkillSummary, SkillServiceOptions, LoadedSkillInfo } from "./skill.types"
import type { ISkillGateway } from "./skill.gateway"
import { stripAdminBlocks } from "../../agent/domain/adminBlocks"

const DEFAULT_OPTIONS: SkillServiceOptions = {
  selection: "model",
  retainTurns: 3,
  env: process.env,
  hasBin: (bin) => Bun.which(bin) !== null,
  exclude: [],
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

  /** `source` is the agent config's own `skills` object: reload() after the S3 pull replaces `exclude` on it, so it is read at load time (CLEAN-214). */
  constructor(private gateway: ISkillGateway, private source: Partial<SkillServiceOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...source }
  }

  async load(): Promise<void> {
    const excluded = new Set(this.source.exclude ?? this.opts.exclude)
    // An excluded skill is neither catalogued nor loadable (CLEAN-214).
    this.skills = (await this.gateway.loadAll()).filter(s => !excluded.has(s.name))
  }

  /** Every skill on disk, whole: for the agent's own bookkeeping (reload, counts), not for a turn. */
  getAll(): Skill[] {
    return this.skills
  }

  /**
   * The skills a turn may read (CLEAN-232). An admin gets every skill whole.
   * Anybody else gets none of the skills marked `audience: admin`, and the
   * rest without their admin-only blocks. Everything below that puts a skill
   * in front of the model goes through here, so a skill hidden from the
   * catalogue cannot be reached by name either. `isAdmin` defaults to false:
   * a caller that does not say who is asking gets the visitor's view.
   */
  visibleTo(isAdmin = false): Skill[] {
    if (isAdmin) return this.skills
    return this.skills
      .filter(s => s.metadata?.audience !== "admin")
      .map(s => ({ ...s, content: stripAdminBlocks(s.content) }))
  }

  get(name: string, isAdmin = false): Skill | undefined {
    return this.visibleTo(isAdmin).find(s => s.name === name)
  }

  /** Catalogue entries for the system prompt, with the reason when a skill cannot be loaded. */
  summaries(isAdmin = false): SkillSummary[] {
    return this.visibleTo(isAdmin).map(s => {
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

  /**
   * The model pulled a skill in: remember it for `retainTurns` turns. Throws on unknown or unavailable skills.
   * A skill this sender may not read is unknown, in the same words.
   */
  markLoaded(sessionId: string, name: string, turn: number, isAdmin = false): LoadedSkillInfo {
    const skill = this.get(name, isAdmin)
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

  /** Skills still active for a session at `turn`, as this sender may read them; expired ones are released here. */
  activeFor(sessionId: string, turn: number, isAdmin = false): Skill[] {
    const list = this.loaded.get(sessionId) ?? []
    // Loaded at turn N → still active through turn N + retainTurns.
    const kept = list.filter(l => turn - l.lastUsedTurn <= this.opts.retainTurns)
    if (kept.length !== list.length) this.loaded.set(sessionId, kept)
    return kept.map(l => this.get(l.name, isAdmin)).filter((s): s is Skill => !!s)
  }

  /**
   * Legacy keyword selection — only under `skills.selection: "keyword"`.
   * Under `model` the agent pulls skills itself with `skill_load`, so this
   * returns null and the catalogue is the only thing in the prompt.
   */
  select(message: string, isAdmin = false): Skill | null {
    if (this.opts.selection !== "keyword") return null
    const skills = this.visibleTo(isAdmin)
    if (skills.length === 0) return null

    const words = message.toLowerCase().split(/\W+/).filter(w => w.length > 3)
    if (words.length === 0) return null

    let best: Skill | null = null
    let bestScore = 0

    for (const skill of skills) {
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
