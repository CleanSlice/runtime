import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { truncateKeepingRules, RULES_HEADING_RE, FileRepository } from "./file.repository"
import { boundCurated } from "../../../domain/curatedBound"
import { DEFAULT_MEMORY_LIMITS } from "../../../domain/memory.types"

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

  test("the rules lead the bounded copy; the kept reference material follows (CLEAN-207)", () => {
    const text = `# Soul\n\n## Reference\n\n${reference}\n\n${rules}`
    const out = truncateKeepingRules(text, rules.length + 200)
    expect(out.text.startsWith("## Rules")).toBe(true)
    expect(out.text.indexOf("## Rules")).toBeLessThan(out.text.indexOf("truncated"))
  })
})

describe("enforceMdLimits (CLEAN-207)", () => {
  test("reports an oversized SOUL.md with its size on disk and leaves the file untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "curated-"))
    const soul = `# Soul\n\n## Reference\n\n${reference}\n\n${rules}`
    writeFileSync(join(dir, "SOUL.md"), soul)
    const repo = new FileRepository(dir, { ...DEFAULT_MEMORY_LIMITS, soul: rules.length + 200 })

    const reports = repo.enforceMdLimits()

    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ file: "SOUL.md", limit: rules.length + 200, chars: soul.length, over: false })
    expect(reports[0]!.dropped).toBeGreaterThan(0)
    expect(readFileSync(join(dir, "SOUL.md"), "utf-8")).toBe(soul)
  })

  test("a file within its limit is not reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "curated-"))
    writeFileSync(join(dir, "SOUL.md"), `# Soul\n\n${rules}`)
    const repo = new FileRepository(dir, { ...DEFAULT_MEMORY_LIMITS, soul: 10_000 })
    expect(repo.enforceMdLimits()).toEqual([])
  })
})

describe("boundCurated (CLEAN-207)", () => {
  test("carries the limit, the size on disk and a fitted copy for a curated file", () => {
    const soul = `# Soul\n\n## Reference\n\n${reference}\n\n${rules}`
    const limit = rules.length + 200
    const out = boundCurated("SOUL.md", soul, { ...DEFAULT_MEMORY_LIMITS, soul: limit })
    expect(out).toMatchObject({ file: "SOUL.md", limit, chars: soul.length, over: false })
    expect(out.text.length).toBeLessThanOrEqual(limit)
    expect(out.text).toContain("1. Never pretend.")
    expect(out.dropped).toBeGreaterThan(0)
  })

  test("a file without a limit key passes through whole", () => {
    const out = boundCurated("AGENTS.md", reference, { ...DEFAULT_MEMORY_LIMITS, soul: 10 })
    expect(out.text).toBe(reference)
    expect(out.dropped).toBe(0)
  })
})
