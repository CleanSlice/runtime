import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { Tool } from "./tool.types"
import { ALWAYS_ENABLED_TOOLS, pruneDisabledTools } from "./toolEnabled"

const tool = (name: string): Tool => ({ name, description: name, schema: z.any(), execute: async () => null })

describe("tools.enabled (CLEAN-214)", () => {
  test("keeps the named built-ins, every MCP tool and the catalogue's own two, and drops the rest in place", () => {
    const tools = [
      tool("exec"), tool("http"), tool("render_form"), tool("skill_load"), tool("tool_describe"),
      tool("Documents__query_knowledge"), tool("CleanSlice__search"),
    ]
    const dropped = pruneDisabledTools(tools, ["render_form"])

    expect(dropped).toEqual(["exec", "http"])
    expect(tools.map(t => t.name)).toEqual([
      "render_form", "skill_load", "tool_describe", "Documents__query_knowledge", "CleanSlice__search",
    ])
  })

  test("an empty or absent list keeps everything, as before", () => {
    const tools = [tool("exec"), tool("file")]
    expect(pruneDisabledTools(tools, [])).toEqual([])
    expect(pruneDisabledTools(tools, undefined)).toEqual([])
    expect(tools).toHaveLength(2)
  })

  test("a name the list carries that no tool has is simply ignored", () => {
    const tools = [tool("exec"), ...ALWAYS_ENABLED_TOOLS.map(tool)]
    expect(pruneDisabledTools(tools, ["no_such_tool"])).toEqual(["exec"])
    expect(tools.map(t => t.name)).toEqual([...ALWAYS_ENABLED_TOOLS])
  })
})
