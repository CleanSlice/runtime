import { describe, expect, test } from "bun:test"
import { AgentService, SECTION_SEPARATOR } from "./agent.service"
import type { IAgentGateway } from "./agent.gateway"
import type { AgentConfig } from "./agent.types"

const gateway: IAgentGateway = {
  load: async () => ({ skills: [] }),
  loadUserContext: async () => undefined,
} as unknown as IAgentGateway

const config: AgentConfig = {
  soul: "Be brief.\n\n<!-- admin-only -->Secret admin paragraph.<!-- /admin-only -->",
  user: "Works nights.",
  memory: "Likes tables.",
  skills: [{ name: "ranch", description: "Operate the ranch API" }],
}

describe("buildSystemPrompt breakdown (CLEAN-150 US2)", () => {
  test("section chars plus separators add up to the prompt length", () => {
    const built = new AgentService(gateway).buildSystemPrompt(config, {
      isAdmin: true,
      toolingPrompt: "## Tooling\n- exec",
      secretKeys: ["GITHUB_TOKEN"],
      agentDir: "/agent",
    })
    const chars = built.sections.reduce((n, s) => n + s.chars, 0)
    const separators = (built.sections.length - 1) * SECTION_SEPARATOR.length
    expect(chars + separators).toBe(built.prompt.length)
  })

  test("every section is named and appears in emission order", () => {
    const built = new AgentService(gateway).buildSystemPrompt(config, { isAdmin: true, toolingPrompt: "## Tooling" })
    expect(built.sections.map(s => s.name)).toEqual(["soul", "tooling", "user", "memory", "skillsCatalog", "silent"])
  })

  test("admin-only content is stripped for non-admins and the soul section shrinks accordingly", () => {
    const service = new AgentService(gateway)
    const admin = service.buildSystemPrompt(config, { isAdmin: true })
    const visitor = service.buildSystemPrompt(config, { isAdmin: false })
    const soulOf = (b: typeof admin) => b.sections.find(s => s.name === "soul")!.chars
    expect(soulOf(visitor)).toBeLessThan(soulOf(admin))
    expect(visitor.prompt).not.toContain("Secret admin paragraph")
  })

  test("HEARTBEAT.md is read without its admin-only blocks by anybody who is not an admin (CLEAN-232)", () => {
    const service = new AgentService(gateway)
    const withHeartbeat: AgentConfig = {
      skills: [],
      heartbeat: "Runs every 30 minutes.\n\n<!-- admin-only -->Sweep with `list_agents`.<!-- /admin-only -->",
    }
    const admin = service.buildSystemPrompt(withHeartbeat, { isAdmin: true })
    const visitor = service.buildSystemPrompt(withHeartbeat, { isAdmin: false })
    expect(admin.prompt).toContain("list_agents")
    expect(visitor.prompt).toContain("Runs every 30 minutes.")
    expect(visitor.prompt).not.toContain("list_agents")
    expect(visitor.prompt).not.toContain("admin-only")
    // A heartbeat that is nothing but an admin-only block leaves no empty section.
    const onlyAdmin = service.buildSystemPrompt({ skills: [], heartbeat: "<!-- admin-only -->x<!-- /admin-only -->" }, { isAdmin: false })
    expect(onlyAdmin.sections.map(s => s.name)).not.toContain("heartbeat")
  })

  test("optional sections are absent, not zero-width entries", () => {
    const built = new AgentService(gateway).buildSystemPrompt({ skills: [] }, {})
    expect(built.sections.map(s => s.name)).toEqual(["silent"])
  })
})
