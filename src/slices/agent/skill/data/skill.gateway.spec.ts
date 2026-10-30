import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "fs"
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
describe("bundled skills", () => {
  test("none is always-on", async () => {
    const gateway = new SkillGateway(mkdtempSync(join(tmpdir(), "agent-")), EXAMPLE_SKILLS)
    const skills = await gateway.loadAll()

    expect(skills.map((s) => s.name)).toContain("ranch-sessions")
    expect(skills.filter((s) => s.metadata?.always).map((s) => s.name)).toEqual([])
  })
})
