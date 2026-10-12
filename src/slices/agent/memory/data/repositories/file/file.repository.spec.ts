import { describe, expect, test } from "bun:test"
import { truncateKeepingRules, RULES_HEADING_RE } from "./file.repository"

const rules = "## Rules\n\n1. Never pretend.\n2. Act, don't talk.\n"
const reference = Array.from({ length: 40 }, (_, i) => `- GET /things/${i} — lists thing ${i}`).join("\n")

describe("truncateKeepingRules (CLEAN-150 US2)", () => {
  test("content within the limit is returned unchanged", () => {
    const text = `# Soul\n\n${rules}\n## Reference\n\nshort`
    const out = truncateKeepingRules(text, 10_000)
    expect(out.text).toBe(text)
    expect(out.over).toBe(false)
    expect(out.dropped).toBe(0)
  })

  test("reference sections are dropped before any rule line", () => {
    const text = `# Soul\n\n## Reference\n\n${reference}\n\n${rules}`
    const out = truncateKeepingRules(text, rules.length + 200)
    expect(out.text).toContain("1. Never pretend.")
    expect(out.text).toContain("2. Act, don't talk.")
    expect(out.text.length).toBeLessThanOrEqual(rules.length + 200)
    expect(out.text).toContain("truncated")
    expect(out.over).toBe(false)
    expect(out.dropped).toBeGreaterThan(0)
  })

  test("the rules section is kept whole even when it alone exceeds the limit, and over is reported", () => {
    const bigRules = "## Rules\n\n" + Array.from({ length: 50 }, (_, i) => `${i}. Rule number ${i} that is quite long.`).join("\n")
    const out = truncateKeepingRules(`# Soul\n\n## Reference\n\n${reference}\n\n${bigRules}`, 500)
    expect(out.text).toContain("Rule number 49")
    expect(out.text).toContain("Rule number 0")
    expect(out.over).toBe(true)
  })

  test("heading match is case-insensitive and tolerates trailing text", () => {
    expect(RULES_HEADING_RE.test("## Rules")).toBe(true)
    expect(RULES_HEADING_RE.test("## rules (hard)")).toBe(true)
    expect(RULES_HEADING_RE.test("## Rulesets")).toBe(false)
    expect(RULES_HEADING_RE.test("### Rules")).toBe(false)
  })

  test("without a rules section it behaves like oldest-first truncation", () => {
    const out = truncateKeepingRules(reference, 300)
    expect(out.text.length).toBeLessThanOrEqual(300)
    expect(out.text).toContain("thing 39")
    expect(out.over).toBe(false)
  })
})
