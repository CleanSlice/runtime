import { describe, expect, test } from "bun:test"
import { InstinctService, instinctId } from "./instinct.service"
import type { IInstinctGateway } from "./instinct.gateway"
import type { IInstinct } from "./instinct.types"
import { DEFAULT_INSTINCT_CONFIG } from "./instinct.types"

const DAY = 24 * 60 * 60 * 1000

function memoryGateway(initial: IInstinct[] = []) {
  const store = new Map(initial.map(i => [i.id, structuredClone(i)]))
  let lastDecay: number | undefined
  const skills: Array<{ slug: string; description: string; content: string }> = []
  const gw: IInstinctGateway = {
    list: () => [...store.values()].map(i => structuredClone(i)),
    write: (i) => { store.set(i.id, structuredClone(i)) },
    remove: (id) => { store.delete(id) },
    readLastDecay: () => lastDecay,
    writeLastDecay: (ts) => { lastDecay = ts },
    writeSkill: (slug, description, content) => { skills.push({ slug, description, content }); return `/agent/skills/learned-${slug}/SKILL.md` },
  }
  return { gw, store, skills }
}

const ev = (ref = "session:s#e1") => ({ ref, ts: 1_000, note: "operator said so" })

function service(initial: IInstinct[] = [], now = () => 10_000) {
  const { gw, store, skills } = memoryGateway(initial)
  const s = new InstinctService(gw, DEFAULT_INSTINCT_CONFIG, now)
  s.load()
  return { s, store, skills }
}

describe("confidence arithmetic (CLEAN-150 US3)", () => {
  test("starting confidence depends on the source; explicit rules start pinned at core", () => {
    const { s } = service()
    expect(s.create({ trigger: "a", action: "x", source: "correction", evidence: [ev()] }).confidence).toBe(0.6)
    expect(s.create({ trigger: "b", action: "x", source: "error-resolution", evidence: [ev()] }).confidence).toBe(0.5)
    expect(s.create({ trigger: "c", action: "x", source: "repetition", evidence: [ev()] }).confidence).toBe(0.5)
    const rule = s.create({ trigger: "d", action: "x", source: "explicit-rule", evidence: [ev()] })
    expect(rule.confidence).toBe(0.9)
    expect(rule.pinned).toBe(true)
    expect(s.bandOf(rule.confidence)).toBe("core")
  })

  test("reinforce adds 0.05 up to 0.95; correct subtracts 0.2 down to 0.1", () => {
    const { s } = service()
    const i = s.create({ trigger: "a", action: "x", source: "correction", evidence: [ev()] })
    s.reinforce(i.id)
    expect(s.get(i.id)!.confidence).toBeCloseTo(0.65, 5)
    for (let k = 0; k < 10; k++) s.reinforce(i.id)
    expect(s.get(i.id)!.confidence).toBe(0.95)
    for (let k = 0; k < 6; k++) s.correct(i.id)
    expect(s.get(i.id)!.confidence).toBe(0.1)
  })

  test("one correction moves a fresh correction-born behaviour from apply to suggested", () => {
    const { s } = service()
    const i = s.create({ trigger: "a", action: "x", source: "correction", evidence: [ev()] })
    expect(s.bandOf(i.confidence)).toBe("apply")
    s.correct(i.id)
    expect(s.bandOf(s.get(i.id)!.confidence)).toBe("suggested")
  })

  test("reinforcement updates the reinforced timestamp and appends evidence", () => {
    let t = 10_000
    const { s } = service([], () => t)
    const i = s.create({ trigger: "a", action: "x", source: "correction", evidence: [ev()] })
    t = 20_000
    s.reinforce(i.id, ev("session:s#e2"))
    expect(s.get(i.id)!.reinforced).toBe(20_000)
    expect(s.get(i.id)!.evidence.map(e => e.ref)).toEqual(["session:s#e1", "session:s#e2"])
  })
})

describe("decay", () => {
  test("decays 0.05 per decayDays without reinforcement; pinned behaviours are exempt", () => {
    let t = 0
    const { s } = service([], () => t)
    const plain = s.create({ trigger: "a", action: "x", source: "correction", evidence: [ev()] })
    const pinned = s.create({ trigger: "b", action: "x", source: "explicit-rule", evidence: [ev()] })
    t = 29 * DAY
    s.decayAll()
    expect(s.get(plain.id)!.confidence).toBeCloseTo(0.5, 5)   // two periods
    expect(s.get(pinned.id)!.confidence).toBe(0.9)
  })

  test("decay never goes below the floor and runs at most once per day", () => {
    let t = 0
    const { s } = service([], () => t)
    const i = s.create({ trigger: "a", action: "x", source: "repetition", evidence: [ev()] })
    t = 365 * DAY
    expect(s.decayIfDue()).toBe(true)
    expect(s.get(i.id)!.confidence).toBe(0.1)
    expect(s.decayIfDue()).toBe(false)
  })
})

describe("bands, prune, pin, conflicts", () => {
  test("bandOf follows the configured thresholds", () => {
    const { s } = service()
    expect(s.bandOf(0.2)).toBe("hidden")
    expect(s.bandOf(0.3)).toBe("suggested")
    expect(s.bandOf(0.5)).toBe("apply")
    expect(s.bandOf(0.8)).toBe("core")
  })

  test("prune removes only behaviours below suggested for longer than 2×decayDays, unless pinned", () => {
    let t = 0
    const { s, store } = service([], () => t)
    const old = s.create({ trigger: "old", action: "x", source: "repetition", evidence: [ev()] })
    const fresh = s.create({ trigger: "fresh", action: "x", source: "repetition", evidence: [ev()] })
    const pinned = s.create({ trigger: "keep", action: "x", source: "explicit-rule", evidence: [ev()] })
    for (let k = 0; k < 3; k++) { s.correct(old.id); s.correct(fresh.id); s.correct(pinned.id) }
    t = 29 * DAY
    s.reinforce(fresh.id)              // touched recently, stays
    s.correct(fresh.id)
    const removed = s.prune()
    expect(removed).toEqual([old.id])
    expect(store.has(old.id)).toBe(false)
    expect(store.has(fresh.id)).toBe(true)
    expect(store.has(pinned.id)).toBe(true)
  })

  test("prune with an id removes exactly that behaviour", () => {
    const { s, store } = service()
    const i = s.create({ trigger: "a", action: "x", source: "correction", evidence: [ev()] })
    expect(s.prune(i.id)).toEqual([i.id])
    expect(store.size).toBe(0)
  })

  test("pin and unpin toggle the flag", () => {
    const { s } = service()
    const i = s.create({ trigger: "a", action: "x", source: "correction", evidence: [ev()] })
    s.pin(i.id)
    expect(s.get(i.id)!.pinned).toBe(true)
    s.unpin(i.id)
    expect(s.get(i.id)!.pinned).toBe(false)
  })

  test("a conflict marks the lower-confidence behaviour, which then stays out of the prompt", () => {
    const { s } = service()
    const strong = s.create({ trigger: "restarting an agent", action: "ask first", source: "explicit-rule", evidence: [ev()] })
    const weak = s.create({ trigger: "the operator wants an agent restarted quickly", action: "just do it", source: "repetition", evidence: [ev()] })
    s.markConflict(strong.id, weak.id)
    expect(s.get(weak.id)!.conflictsWith).toBe(strong.id)
    expect(s.get(strong.id)!.conflictsWith).toBeUndefined()
    expect(s.render()).toContain("ask first")
    expect(s.render()).not.toContain("just do it")
    expect(s.summary().conflicts).toBe(1)
  })
})

describe("render", () => {
  test("core reads as standing rules, apply as learned behaviours, suggested is omitted, capped at maxInjected", () => {
    const { s } = service()
    s.create({ trigger: "restart an agent", action: "ask for confirmation", source: "explicit-rule", evidence: [ev()] })
    s.create({ trigger: "listing agents", action: "names only", source: "correction", evidence: [ev()] })
    const weak = s.create({ trigger: "weak", action: "maybe", source: "repetition", evidence: [ev()] })
    s.correct(weak.id)
    const out = s.render()
    expect(out).toContain("## Standing rules")
    expect(out).toContain("ask for confirmation")
    expect(out).toContain("## Learned behaviours")
    expect(out).toContain("names only")
    expect(out).not.toContain("maybe")

    for (let k = 0; k < 12; k++) s.create({ trigger: `t${k}`, action: `a${k}`, source: "correction", evidence: [ev()] })
    const capped = s.render(3)
    expect(capped.match(/^- /gm)?.length).toBe(3)
  })

  test("nothing to render yields an empty string", () => {
    const { s } = service()
    expect(s.render()).toBe("")
  })
})

describe("review output", () => {
  test("applies new / reinforce / correct items; an explicit rule enters pinned at core", () => {
    const { s } = service()
    const existing = s.create({ trigger: "a", action: "x", source: "correction", evidence: [ev()] })
    const applied = s.applyReview([
      { kind: "new", trigger: "never restart without asking", action: "ask first", source: "explicit-rule", evidence: [ev()] },
      { kind: "reinforce", id: existing.id },
      { kind: "correct", id: "does-not-exist" },
    ])
    expect(applied.created).toHaveLength(1)
    expect(applied.created[0]!.pinned).toBe(true)
    expect(applied.created[0]!.confidence).toBe(0.9)
    expect(s.get(existing.id)!.confidence).toBeCloseTo(0.65, 5)
    expect(applied.ignored).toEqual(["does-not-exist"])
  })

  test("a new item whose trigger matches an existing one reinforces instead of duplicating", () => {
    const { s, store } = service()
    const a = s.create({ trigger: "Listing agents", action: "names only", source: "correction", evidence: [ev()] })
    s.applyReview([{ kind: "new", trigger: "listing agents", action: "names only please", source: "repetition", evidence: [ev("session:s#e9")] }])
    expect(store.size).toBe(1)
    expect(s.get(a.id)!.confidence).toBeCloseTo(0.65, 5)
  })

  test("instinctId is a stable slug plus hash", () => {
    expect(instinctId("Never restart an agent without asking")).toBe(instinctId("never restart an agent without asking"))
    expect(instinctId("a")).toMatch(/^a-[a-f0-9]{6}$/)
  })
})

describe("promote", () => {
  test("writes a skill from the chosen behaviours and marks them promoted", () => {
    const { s, skills } = service()
    const a = s.create({ trigger: "restart an agent", action: "ask first", source: "explicit-rule", evidence: [ev()] })
    const b = s.create({ trigger: "delete an agent", action: "ask twice", source: "correction", evidence: [ev()] })
    const result = s.promote([a.id, b.id], "agent-safety")
    expect(result.path).toContain("learned-agent-safety")
    expect(skills[0]!.content).toContain("ask first")
    expect(skills[0]!.content).toContain("ask twice")
    expect(skills[0]!.description).toContain("restart an agent")
    expect(s.get(a.id)!.promotedTo).toBe("learned-agent-safety")
  })
})
