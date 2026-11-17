import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { SkillGateway } from "./skill.gateway"

const EXAMPLE_SKILLS = resolve(__dirname, "../../../../../.agent.example/skills")

/**
 * The skills shipped with the runtime reach every agent built on it. One of
 * them marked `metadata.always: true` is appended whole to every system
 * prompt of every agent — `ranch-sessions` did that with 15 KB of social
 * media recipes for a product advisor that drives no social account
 * (CLEAN-199). A bundled skill is on demand: its catalogue line says when
 * to load it, and `skill_load` brings the body in for a few turns.
 */
/** `audience: admin` in a skill's frontmatter (CLEAN-232): see SkillService.visibleTo. */
describe("a skill's audience", () => {
  async function load(frontmatter: string) {
    const agentDir = mkdtempSync(join(tmpdir(), "agent-"))
    mkdirSync(join(agentDir, "skills", "ranch"), { recursive: true })
    writeFileSync(join(agentDir, "skills", "ranch", "SKILL.md"), `---\nname: ranch\ndescription: Operate the Ranch\n${frontmatter}---\n\nbody\n`)
    const skills = await new SkillGateway(agentDir, mkdtempSync(join(tmpdir(), "bundled-"))).loadAll()
    return skills.find((s) => s.name === "ranch")
  }

  test("audience: admin at the top level", async () => {
    expect((await load("audience: admin\n"))?.metadata?.audience).toBe("admin")
  })

  test("audience: admin under metadata, next to always", async () => {
    const skill = await load("metadata:\n  always: true\n  audience: admin\n")
    expect(skill?.metadata).toMatchObject({ always: true, audience: "admin" })
  })

  test("no audience, or any other word, is everyone", async () => {
    expect((await load(""))?.metadata?.audience).toBeUndefined()
    expect((await load("audience: everyone\n"))?.metadata?.audience).toBeUndefined()
  })
})

describe("bundled skills", () => {
  test("none is always-on", async () => {
    const gateway = new SkillGateway(mkdtempSync(join(tmpdir(), "agent-")), EXAMPLE_SKILLS)
    const skills = await gateway.loadAll()

    expect(skills.map((s) => s.name)).toContain("ranch-sessions")
    expect(skills.filter((s) => s.metadata?.always).map((s) => s.name)).toEqual([])
  })
})
