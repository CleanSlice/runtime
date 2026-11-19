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

/**
 * A skill for the agent's administrators only (frontmatter `audience: admin`,
 * CLEAN-232). The Ranch admin agent's `ranch` skill names every management
 * tool; a User read it whole, and a model that reads a tool name tries it.
 */
describe("a skill for administrators only", () => {
  const ranch = skill("ranch", "Operate the ranch platform agents", {
    content: "Call `list_agents` first.",
    metadata: { always: true, audience: "admin" },
  })
  const faq = skill("faq", "Answer product questions from the manual", {
    content: "Answer from the manual.\n\n<!-- admin-only -->The source lives in `write_agent_file`.<!-- /admin-only -->",
  })

  test("is not in the catalogue of anybody who is not an admin", async () => {
    const s = await service([ranch, faq])
    expect(s.summaries(false).map(x => x.name)).toEqual(["faq"])
    expect(s.summaries(true).map(x => x.name)).toEqual(["ranch", "faq"])
    // Not saying who is asking is the visitor's view.
    expect(s.summaries().map(x => x.name)).toEqual(["faq"])
  })

  test("is not among the skills a turn may read, always-on or not", async () => {
    const s = await service([ranch, faq])
    expect(s.visibleTo(false).map(x => x.name)).toEqual(["faq"])
    expect(s.visibleTo(false).filter(x => x.metadata?.always)).toEqual([])
    expect(s.visibleTo(true).filter(x => x.metadata?.always).map(x => x.name)).toEqual(["ranch"])
    expect(s.get("ranch", false)).toBeUndefined()
    expect(s.get("ranch", true)?.content).toContain("list_agents")
  })

  test("skill_load answers a visitor exactly as for a skill that does not exist", async () => {
    const s = await service([ranch, faq])
    const refusal = (name: string) => {
      try { s.markLoaded("s1", name, 1, false); return "loaded" } catch (e) { return (e as Error).message.replace(name, "<name>") }
    }
    expect(refusal("ranch")).toBe("unknown skill: <name>")
    expect(refusal("ranch")).toBe(refusal("no-such-skill"))
    expect(s.activeFor("s1", 1, false)).toEqual([])
    expect(s.markLoaded("s1", "ranch", 1, true)).toMatchObject({ name: "ranch" })
  })

  test("one an admin loaded does not ride into a visitor's turn of the same session", async () => {
    const s = await service([ranch, faq])
    s.markLoaded("s1", "ranch", 1, true)
    expect(s.activeFor("s1", 2, true).map(x => x.name)).toEqual(["ranch"])
    expect(s.activeFor("s1", 2, false)).toEqual([])
  })

  test("keyword selection does not pick it for a visitor", async () => {
    const s = await service([ranch], { selection: "keyword" })
    expect(s.select("please list the ranch agents", true)?.name).toBe("ranch")
    expect(s.select("please list the ranch agents", false)).toBeNull()
  })

  test("any other skill reaches a visitor without its admin-only blocks, and an admin whole", async () => {
    const s = await service([faq])
    s.markLoaded("s1", "faq", 1, false)
    const forVisitor = s.activeFor("s1", 1, false)[0]!.content
    expect(forVisitor).toBe("Answer from the manual.")
    expect(s.get("faq", false)!.content).not.toContain("write_agent_file")
    expect(s.activeFor("s1", 1, true)[0]!.content).toContain("write_agent_file")
    // The skill on disk is not rewritten.
    expect(s.getAll()[0]!.content).toContain("admin-only")
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

describe("skills.exclude (CLEAN-214)", () => {
  const skill = (name: string): Skill => ({
    name,
    description: `${name} description`,
    path: `/skills/${name}/SKILL.md`,
    content: `# ${name}`,
    source: "agent",
  })

  test("an excluded skill is neither catalogued nor loadable, the others are untouched", async () => {
    const s = new SkillService(gateway([skill("ranch-sessions"), skill("skill-creator"), skill("mazda-comparisons")]), {
      exclude: ["ranch-sessions", "skill-creator"],
    })
    await s.load()

    expect(s.getAll().map(x => x.name)).toEqual(["mazda-comparisons"])
    expect(s.summaries().map(x => x.name)).toEqual(["mazda-comparisons"])
    expect(s.get("skill-creator")).toBeUndefined()
  })

  test("exclude is read from the config object at load time, so a reload after the S3 pull counts", async () => {
    const live: { exclude?: string[] } = { exclude: [] }
    const s = new SkillService(gateway([skill("ranch-sessions"), skill("mazda-comparisons")]), live)
    live.exclude = ["ranch-sessions"]
    await s.load()
    expect(s.getAll().map(x => x.name)).toEqual(["mazda-comparisons"])
  })

  test("without an exclude list every skill loads as before", async () => {
    const s = new SkillService(gateway([skill("ranch-sessions"), skill("mazda-comparisons")]))
    await s.load()
    expect(s.getAll().map(x => x.name)).toEqual(["ranch-sessions", "mazda-comparisons"])
  })
})
