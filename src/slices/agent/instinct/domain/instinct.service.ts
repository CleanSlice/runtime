import { createHash } from "crypto"
import type { IInstinctGateway } from "./instinct.gateway"
import type { IEvidence, IInstinct, IInstinctConfig, IInstinctSummary, InstinctBand, InstinctSource, ReviewItem } from "./instinct.types"
import { CONFIDENCE_MAX, CONFIDENCE_MIN, DEFAULT_INSTINCT_CONFIG } from "./instinct.types"
import { createLogger } from "../../../setup/logger"

const log = createLogger("instinct")
const DAY_MS = 24 * 60 * 60 * 1000

/** A stable id for a trigger: slug of its first words plus a short hash of the normalised text. */
export function instinctId(trigger: string): string {
  const norm = trigger.trim().toLowerCase().replace(/\s+/g, " ")
  const slug = norm.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 6).join("-") || "instinct"
  const hash = createHash("sha1").update(norm).digest("hex").slice(0, 6)
  return `${slug}-${hash}`
}

export interface ICreateInput {
  trigger: string
  action: string
  source: InstinctSource
  evidence: IEvidence[]
  scope?: "agent" | "shared"
}

/**
 * Learned behaviours with confidence (CLEAN-150 US3). One trigger, one
 * action, a score that experience moves: reinforcement up, correction down,
 * time without either slowly down. Bands decide what a behaviour may do;
 * nothing here ever reaches the guard — rules win by construction.
 */
export class InstinctService {
  private items = new Map<string, IInstinct>()

  constructor(
    private gateway: IInstinctGateway,
    private cfg: IInstinctConfig = DEFAULT_INSTINCT_CONFIG,
    private now: () => number = () => Date.now(),
  ) {}

  load(): void {
    this.items = new Map(this.gateway.list().map(i => [i.id, i]))
  }

  list(): IInstinct[] {
    return [...this.items.values()].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
  }

  get(id: string): IInstinct | undefined {
    return this.items.get(id)
  }

  bandOf(confidence: number): InstinctBand {
    const b = this.cfg.bands
    if (confidence >= b.core) return "core"
    if (confidence >= b.apply) return "apply"
    if (confidence >= b.suggested) return "suggested"
    return "hidden"
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  create(input: ICreateInput): IInstinct {
    const id = instinctId(input.trigger)
    const existing = this.items.get(id)
    if (existing) {
      // Same trigger learned again is a reinforcement, not a twin.
      return this.reinforce(id, input.evidence[0])!
    }
    const explicit = input.source === "explicit-rule"
    const start = {
      correction: this.cfg.start.correction,
      "error-resolution": this.cfg.start.errorResolution,
      repetition: this.cfg.start.repetition,
      "explicit-rule": this.cfg.start.explicitRule,
    }[input.source]
    const ts = this.now()
    const instinct: IInstinct = {
      id,
      trigger: input.trigger.trim(),
      action: input.action.trim(),
      confidence: clamp(start),
      scope: input.scope ?? "agent",
      source: input.source,
      pinned: explicit,
      evidence: input.evidence.slice(0, 20),
      created: ts,
      reinforced: ts,
    }
    this.save(instinct)
    log.info(`learned "${instinct.trigger}" → ${instinct.action.slice(0, 60)} (${instinct.confidence}, ${instinct.source})`)
    return instinct
  }

  reinforce(id: string, evidence?: IEvidence): IInstinct | undefined {
    const i = this.items.get(id)
    if (!i) return undefined
    i.confidence = clamp(i.confidence + this.cfg.reinforce)
    i.reinforced = this.now()
    if (evidence) i.evidence = [...i.evidence, evidence].slice(-20)
    this.save(i)
    return i
  }

  correct(id: string, evidence?: IEvidence): IInstinct | undefined {
    const i = this.items.get(id)
    if (!i) return undefined
    i.confidence = clamp(i.confidence - this.cfg.correct)
    i.reinforced = this.now()
    if (evidence) i.evidence = [...i.evidence, evidence].slice(-20)
    this.save(i)
    log.info(`corrected "${i.trigger}" → ${i.confidence}`)
    return i
  }

  /** Apply time decay to every unpinned behaviour: −decay per full decayDays since last reinforcement. */
  decayAll(): number {
    const now = this.now()
    let touched = 0
    for (const i of this.items.values()) {
      if (i.pinned) continue
      const periods = Math.floor((now - i.reinforced) / (this.cfg.decayDays * DAY_MS))
      if (periods <= 0) continue
      const next = clamp(i.confidence - periods * this.cfg.decay)
      if (next === i.confidence) continue
      i.confidence = next
      // Decay already counted these periods; move the clock so it is not counted twice.
      i.reinforced = i.reinforced + periods * this.cfg.decayDays * DAY_MS
      this.save(i)
      touched++
    }
    return touched
  }

  /** Run decay once a day at most; returns whether it ran. Called from the heartbeat tick. */
  decayIfDue(): boolean {
    const last = this.gateway.readLastDecay() ?? 0
    if (this.now() - last < DAY_MS) return false
    this.decayAll()
    this.gateway.writeLastDecay(this.now())
    return true
  }

  pin(id: string): void {
    const i = this.items.get(id)
    if (i) { i.pinned = true; this.save(i) }
  }

  unpin(id: string): void {
    const i = this.items.get(id)
    if (i) { i.pinned = false; this.save(i) }
  }

  /**
   * Without an id: remove every unpinned behaviour that has sat below the
   * suggested band for more than twice the decay period. With an id: remove
   * that one. Returns the ids removed.
   */
  prune(id?: string): string[] {
    const removed: string[] = []
    if (id) {
      if (this.items.has(id)) { this.items.delete(id); this.gateway.remove(id); removed.push(id) }
      return removed
    }
    const stale = 2 * this.cfg.decayDays * DAY_MS
    for (const i of [...this.items.values()]) {
      if (i.pinned) continue
      if (i.confidence < this.cfg.bands.suggested && this.now() - i.reinforced > stale) {
        this.items.delete(i.id)
        this.gateway.remove(i.id)
        removed.push(i.id)
      }
    }
    return removed
  }

  /** `loser` contradicts `winner`; the loser stays out of the prompt until the operator decides. */
  markConflict(winnerId: string, loserId: string): void {
    const w = this.items.get(winnerId)
    const l = this.items.get(loserId)
    if (!w || !l) return
    // The higher confidence is the one that applies, whatever the caller said.
    const [keep, drop] = w.confidence >= l.confidence ? [w, l] : [l, w]
    drop.conflictsWith = keep.id
    this.save(drop)
    if (keep.conflictsWith === drop.id) { delete keep.conflictsWith; this.save(keep) }
  }

  conflicts(): Array<{ winner: IInstinct; loser: IInstinct }> {
    const out: Array<{ winner: IInstinct; loser: IInstinct }> = []
    for (const loser of this.items.values()) {
      const winner = loser.conflictsWith ? this.items.get(loser.conflictsWith) : undefined
      if (winner) out.push({ winner, loser })
    }
    return out
  }

  // ── Prompt / review ──────────────────────────────────────────────────────────

  /** Markdown for the system prompt: core behaviours as rules, apply-band as learned behaviours. */
  render(maxInjected = this.cfg.maxInjected): string {
    if (!this.cfg.enabled) return ""
    const eligible = this.list().filter(i => !i.conflictsWith && !i.promotedTo && this.bandOf(i.confidence) !== "hidden" && this.bandOf(i.confidence) !== "suggested")
    const chosen = eligible.slice(0, maxInjected)
    const core = chosen.filter(i => this.bandOf(i.confidence) === "core")
    const apply = chosen.filter(i => this.bandOf(i.confidence) === "apply")
    const line = (i: IInstinct) => `- When ${i.trigger}: ${i.action}`
    const parts: string[] = []
    if (core.length) parts.push(`## Standing rules\n\n${core.map(line).join("\n")}`)
    if (apply.length) parts.push(`## Learned behaviours\n\nApply these when the trigger matches; the operator can correct any of them.\n\n${apply.map(line).join("\n")}`)
    return parts.join("\n\n")
  }

  /** Ids rendered by `render()` with the same cap — the loop reinforces these after an uncorrected turn. */
  renderedIds(maxInjected = this.cfg.maxInjected): string[] {
    return this.list()
      .filter(i => !i.conflictsWith && !i.promotedTo && ["core", "apply"].includes(this.bandOf(i.confidence)))
      .slice(0, maxInjected)
      .map(i => i.id)
  }

  /** Apply what a review pass found. Unknown ids are reported, not invented. */
  applyReview(items: ReviewItem[]): { created: IInstinct[]; reinforced: string[]; corrected: string[]; ignored: string[] } {
    const created: IInstinct[] = []
    const reinforced: string[] = []
    const corrected: string[] = []
    const ignored: string[] = []
    for (const item of items) {
      if (item.kind === "new") {
        const before = this.items.size
        const i = this.create({ trigger: item.trigger, action: item.action, source: item.source, evidence: item.evidence })
        if (this.items.size > before) created.push(i)
        else reinforced.push(i.id)
        if (item.conflictsWith && this.items.has(item.conflictsWith)) this.markConflict(item.conflictsWith, i.id)
      } else if (item.kind === "reinforce") {
        if (this.reinforce(item.id, item.evidence)) reinforced.push(item.id)
        else ignored.push(item.id)
      } else if (item.kind === "correct") {
        if (this.correct(item.id, item.evidence)) corrected.push(item.id)
        else ignored.push(item.id)
      }
    }
    return { created, reinforced, corrected, ignored }
  }

  summary(): IInstinctSummary {
    const s: IInstinctSummary = { core: 0, apply: 0, suggested: 0, hidden: 0, conflicts: 0, pinned: 0 }
    for (const i of this.items.values()) {
      s[this.bandOf(i.confidence)]++
      if (i.conflictsWith) s.conflicts++
      if (i.pinned) s.pinned++
    }
    return s
  }

  /** Turn behaviours into a skill file for review; they stay, marked as promoted. */
  promote(ids: string[], slug: string): { name: string; path: string } {
    const chosen = ids.map(id => this.items.get(id)).filter((i): i is IInstinct => !!i)
    if (chosen.length === 0) throw new Error("no matching behaviours to promote")
    const name = `learned-${slug}`
    const description = `When ${chosen.map(i => i.trigger).join("; ")}`
    const content =
      `# Learned behaviours\n\n` +
      `Promoted from the agent's own experience. Review and edit freely; the source behaviours stay in \`memory/instincts/\`.\n\n` +
      chosen.map(i => `## When ${i.trigger}\n\n${i.action}\n\n_Confidence ${i.confidence} · ${i.source} · evidence ${i.evidence.length}_`).join("\n\n")
    const path = this.gateway.writeSkill(slug, description, content)
    for (const i of chosen) { i.promotedTo = name; this.save(i) }
    return { name, path }
  }

  private save(i: IInstinct): void {
    this.items.set(i.id, i)
    this.gateway.write(i)
  }
}

function clamp(n: number): number {
  return Math.round(Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, n)) * 1000) / 1000
}
