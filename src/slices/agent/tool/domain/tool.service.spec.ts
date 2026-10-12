import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { ToolService } from "./tool.service"
import type { Tool } from "./tool.types"

const tool = (name: string, description: string): Tool => ({
  name, description, schema: z.object({}), execute: async () => null,
})

const tools: Tool[] = [
  tool("exec", "Run a shell command and return stdout/stderr. Blocks until done."),
  tool("http", "Make an HTTP request and return the response."),
  tool("ranch__list_agents", "List every agent on the ranch with its pod state, template and owner. Supports paging and filters by status, template and owner; returns up to 200 rows."),
  tool("ranch__restart_agent", "Restart one agent by id. Waits for the pod to come back and reports the new state."),
]

describe("tooling catalogue budget (CLEAN-150 US2)", () => {
  test("without a core list every tool gets its full description (legacy behaviour)", () => {
    const prompt = ToolService.buildToolingPromptFrom(tools)
    expect(prompt).toContain("Blocks until done")
    expect(prompt).toContain("returns up to 200 rows")
    expect(prompt).not.toContain("tool_describe")
  })

  test("core tools keep the full description, the rest become one-line stubs pointing at tool_describe", () => {
    const prompt = ToolService.buildToolingPromptFrom(tools, { core: ["exec", "http"] })
    expect(prompt).toContain("`exec` — Run a shell command and return stdout/stderr. Blocks until done.")
    expect(prompt).toContain("`http` — Make an HTTP request and return the response.")
    expect(prompt).not.toContain("returns up to 200 rows")
    expect(prompt).toContain("`ranch__list_agents` — List every agent on the ranch with its pod state, template and owner.")
    expect(prompt).not.toContain("Supports paging")
    expect(prompt).toContain("tool_describe")
  })

  test("a stub is at most one line of bounded length", () => {
    const prompt = ToolService.buildToolingPromptFrom(tools, { core: [] })
    const stub = prompt.split("\n").find(l => l.startsWith("- `ranch__list_agents`"))!
    expect(stub.length).toBeLessThanOrEqual(120)
  })

  test("the catalogue shrinks when tools move out of the core set", () => {
    const full = ToolService.buildToolingPromptFrom(tools).length
    const lean = ToolService.buildToolingPromptFrom(tools, { core: ["exec"] }).length
    expect(lean).toBeLessThan(full)
  })
})
