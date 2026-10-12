import { describe, expect, test } from "bun:test"
import { SkillService } from "./skill.service"
import type { ISkillGateway } from "./skill.gateway"
import type { Skill } from "./skill.types"

const skill = (name: string, description: string, extra: Partial<Skill> = {}): Skill => ({
  name, description, path: `/x/${name}/SKILL.md`, content: `# ${name}\n\nbody of ${name}`, source: "agent", ...extra,
})

function gateway(skills: Skill[]): ISkillGateway {
  return {
    loadAll: async () => skills,
    load: async (n) => skills.find(s => s.name === n) ?? null,
    install: async () => { throw new Error("n/a") },
    remove: async () => {},
    searchRegistry: async () => [],
    fetchRegistry: async () => [],
  }
}

async function service(skills: Skill[], opts: { selection?: "model" | "keyword"; retainTurns?: number; env?: Record<string, string | undefined> } = {}) {
  const s = new SkillService(gateway(skills), {
    selection: opts.selection ?? "model",
    retainTurns: opts.retainTurns ?? 3,
    env: opts.env ?? {},
    hasBin: (b) => b === "git",
  })
  await s.load()
  return s
}

describe("per-session skill loading (CLEAN-150 US2)", () => {
  test("a loaded skill is active for retainTurns turns after its last use, then released", async () => {
    const s = await service([skill("ranch", "Operate the ranch API")], { retainTurns: 2 })
    const t1 = s.nextTurn("s1")
    expect(s.markLoaded("s1", "ranch", t1)).toMatchObject({ name: "ranch", retainedForTurns: 2 })
    expect(s.activeFor("s1", t1).map(x => x.name)).toEqual(["ranch"])
    const t2 = s.nextTurn("s1")
    expect(s.activeFor("s1", t2).map(x => x.name)).toEqual(["ranch"])
    const t3 = s.nextTurn("s1")
    expect(s.activeFor("s1", t3).map(x => x.name)).toEqual(["ranch"])
    const t4 = s.nextTurn("s1")
    expect(s.activeFor("s1", t4)).toEqual([])
  })

  test("using a loaded skill again extends its stay", async () => {
    const s = await service([skill("ranch", "Operate the ranch API")], { retainTurns: 1 })
    const t1 = s.nextTurn("s1")
    s.markLoaded("s1", "ranch", t1)
    const t2 = s.nextTurn("s1")
    s.markLoaded("s1", "ranch", t2)
    const t3 = s.nextTurn("s1")
    expect(s.activeFor("s1", t3).map(x => x.name)).toEqual(["ranch"])
    const t4 = s.nextTurn("s1")
    expect(s.activeFor("s1", t4)).toEqual([])
  })

  test("sessions do not see each other's loads", async () => {
    const s = await service([skill("ranch", "Operate the ranch API")])
    const t = s.nextTurn("s1")
    s.markLoaded("s1", "ranch", t)
    expect(s.activeFor("s2", s.nextTurn("s2"))).toEqual([])
  })

  test("loading an unknown skill is an error", async () => {
    const s = await service([])
    expect(() => s.markLoaded("s1", "nope", 1)).toThrow(/unknown skill/)
  })
})

describe("skill availability", () => {
  test("a skill with unmet requirements is unavailable with the reason and cannot be loaded", async () => {
    const needsToken = skill("github", "Work with GitHub", { metadata: { requires: { env: ["GITHUB_TOKEN"], bins: ["git"] } } })
    const s = await service([needsToken], { env: {} })
    expect(s.availability(needsToken)).toEqual({ ok: false, reason: "missing env GITHUB_TOKEN" })
    expect(() => s.markLoaded("s1", "github", 1)).toThrow(/unavailable: missing env GITHUB_TOKEN/)
  })

  test("a missing binary is reported too", async () => {
    const needsGh = skill("gh", "GitHub CLI", { metadata: { requires: { bins: ["gh"] } } })
    const s = await service([needsGh])
    expect(s.availability(needsGh)).toEqual({ ok: false, reason: "missing binary gh" })
  })

  test("satisfied requirements are available", async () => {
    const ok = skill("github", "Work with GitHub", { metadata: { requires: { env: ["GITHUB_TOKEN"], bins: ["git"] } } })
    const s = await service([ok], { env: { GITHUB_TOKEN: "x" } })
    expect(s.availability(ok)).toEqual({ ok: true })
  })

  test("summaries carry the unavailability reason for the catalogue", async () => {
    const needsToken = skill("github", "Work with GitHub", { metadata: { requires: { env: ["GITHUB_TOKEN"] } } })
    const s = await service([needsToken, skill("ranch", "Operate the ranch API")])
    expect(s.summaries()).toEqual([
      { name: "github", description: "Work with GitHub", metadata: needsToken.metadata, unavailable: "missing env GITHUB_TOKEN" },
      { name: "ranch", description: "Operate the ranch API", metadata: undefined },
    ])
  })
})

describe("selection mode", () => {
  test("keyword selection still matches two overlapping words", async () => {
    const s = await service([skill("ranch", "Operate the ranch platform agents")], { selection: "keyword" })
    expect(s.select("please list the ranch agents")?.name).toBe("ranch")
  })

  test("model selection never auto-selects — the agent pulls skills with skill_load", async () => {
    const s = await service([skill("ranch", "Operate the ranch platform agents")], { selection: "model" })
    expect(s.select("please list the ranch agents")).toBeNull()
  })
})
