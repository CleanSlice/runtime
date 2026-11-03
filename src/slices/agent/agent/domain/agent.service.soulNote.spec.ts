import { describe, expect, test } from "bun:test"
import { AgentService, soulLimitNote } from "./agent.service"
import type { IAgentGateway } from "./agent.gateway"
import type { AgentConfig } from "./agent.types"

// The SOUL.md budget line the agent reads (CLEAN-207): it must know the limit
// to say it, and know when part of the file is not in front of it.

const bound = (over: Partial<{ chars: number; limit: number; dropped: number; over: boolean }> = {}) => ({
  file: "SOUL.md",
  limit: 32000,
  chars: 31000,
  dropped: 0,
  over: false,
  text: "",
  ...over,
})

describe("soulLimitNote", () => {
  test("names the size and the limit when the file fits", () => {
    const note = soulLimitNote(bound())
    expect(note).toContain("SOUL.md is 31000 of 32000 characters")
    expect(note).toContain("memory.limits.soul")
    expect(note).not.toContain("left out")
  })

  test("says how much is left out and that the file on disk is whole", () => {
    const note = soulLimitNote(bound({ chars: 33359, dropped: 1369 }))
    expect(note).toContain("1369 characters of non-rule material are left out")
    expect(note).toContain("the file on disk is whole")
    expect(note).toContain("the limit is 32000 characters")
  })

  test("says when the rules alone are over the limit", () => {
    expect(soulLimitNote(bound({ over: true, chars: 40000 }))).toContain("## Rules section alone is over the limit")
  })

  test("is empty without a bound (loaded without limits)", () => {
    expect(soulLimitNote(undefined)).toBe("")
  })
})

describe("buildSystemPrompt soul section", () => {
  const gateway = {
    load: async () => ({ skills: [] }),
    loadUserContext: async () => undefined,
  } as unknown as IAgentGateway

  test("opens the Soul section with the note before the file text", () => {
    const config: AgentConfig = {
      soul: "## Rules\n\n1. Be exact.",
      skills: [],
      curated: { "SOUL.md": bound({ chars: 24, dropped: 0 }) },
    }
    const built = new AgentService(gateway).buildSystemPrompt(config)
    const soulStart = built.prompt.indexOf("# Soul")
    expect(soulStart).toBeGreaterThanOrEqual(0)
    const section = built.prompt.slice(soulStart)
    expect(section.indexOf("SOUL.md is 24 of 32000 characters")).toBeLessThan(section.indexOf("## Rules"))
  })

  test("adds nothing when the config carries no curated numbers", () => {
    const built = new AgentService(gateway).buildSystemPrompt({ soul: "## Rules\n\n1. Be exact.", skills: [] })
    expect(built.prompt).toContain("# Soul\n\n## Rules")
    expect(built.prompt).not.toContain("memory.limits.soul")
  })
})
