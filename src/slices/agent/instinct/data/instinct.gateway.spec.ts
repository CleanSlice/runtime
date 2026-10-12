import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { InstinctGateway } from "./instinct.gateway"
import type { IInstinct } from "../domain/instinct.types"

const sample: IInstinct = {
  id: "confirm-before-restart-ab12cd",
  trigger: "Operator asks to restart an agent",
  action: "Ask for confirmation naming the agent before calling the restart endpoint.",
  confidence: 0.75,
  scope: "agent",
  source: "correction",
  pinned: false,
  evidence: [{ ref: "session:bridle:admin#8f2c", ts: 1791234567000, note: "operator: don't restart without asking" }],
  created: 1791234567000,
  reinforced: 1791834567000,
}

describe("InstinctGateway (CLEAN-150 US3)", () => {
  test("round-trips an instinct through one markdown file", () => {
    const dir = mkdtempSync(join(tmpdir(), "instinct-"))
    const gw = new InstinctGateway(dir)
    gw.write(sample)
    const file = join(dir, "memory", "instincts", `${sample.id}.md`)
    expect(existsSync(file)).toBe(true)
    const raw = readFileSync(file, "utf8")
    expect(raw).toContain("confidence: 0.75")
    expect(raw).toContain("## Action")
    expect(gw.list()).toEqual([sample])
  })

  test("remove deletes the file; list skips malformed files", () => {
    const dir = mkdtempSync(join(tmpdir(), "instinct-"))
    const gw = new InstinctGateway(dir)
    gw.write(sample)
    gw.write({ ...sample, id: "other-000000", trigger: "other" })
    mkdirSync(join(dir, "memory", "instincts"), { recursive: true })
    writeFileSync(join(dir, "memory", "instincts", "broken.md"), "---\nid: [not: valid\n---\nbody")
    writeFileSync(join(dir, "memory", "instincts", "incomplete.md"), "---\nid: incomplete-000000\n---\nno trigger")
    gw.remove(sample.id)
    expect(gw.list().map(i => i.id)).toEqual(["other-000000"])
  })

  test("lastDecay persists under data/", () => {
    const dir = mkdtempSync(join(tmpdir(), "instinct-"))
    const gw = new InstinctGateway(dir)
    expect(gw.readLastDecay()).toBeUndefined()
    gw.writeLastDecay(123)
    expect(gw.readLastDecay()).toBe(123)
    expect(existsSync(join(dir, "data", "instincts.json"))).toBe(true)
  })

  test("writeSkill creates skills/learned-<slug>/SKILL.md with frontmatter", () => {
    const dir = mkdtempSync(join(tmpdir(), "instinct-"))
    const gw = new InstinctGateway(dir)
    const path = gw.writeSkill("agent-safety", "When restarting or deleting agents", "# Learned\n\n- ask first")
    expect(path).toBe(join(dir, "skills", "learned-agent-safety", "SKILL.md"))
    const raw = readFileSync(path, "utf8")
    expect(raw.startsWith("---\nname: learned-agent-safety\n")).toBe(true)
    expect(raw).toContain("description: When restarting or deleting agents")
    expect(raw).toContain("- ask first")
  })
})
