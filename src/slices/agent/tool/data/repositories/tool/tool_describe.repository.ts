import { z } from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  name: z.string().min(1).describe("Tool name exactly as listed in the Tooling section"),
})

/**
 * Full description and parameter schema for a tool the catalogue only shows
 * as a one-line stub (CLEAN-150 US2). The provider still receives every
 * tool's schema; this is the prose the budgeted catalogue left out.
 */
export const ToolDescribeTool: Tool = {
  name: "tool_describe",
  effect: "read",
  description: `Full description and parameters of a tool. Call it before using a tool whose catalogue entry is a one-line stub, or when you are unsure what a tool's parameters mean. Returns description, JSON schema of the parameters, whether it changes anything ("effect") and whether it is admin-only.`,
  schema,
  stepLabel(params: unknown): string | undefined {
    const p = schema.safeParse(params)
    return p.success ? `Describe tool ${p.data.name}` : undefined
  },
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { name } = schema.parse(params)
    const tool = (ctx.tools ?? []).find(t => t.name === name)
    if (!tool) return { error: `Unknown tool: ${name}` }
    return {
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema ?? (zodToJsonSchema(tool.schema) as Record<string, unknown>),
      effect: tool.effectOf ? "depends on the call (read or write)" : (tool.effect ?? "write"),
      adminOnly: tool.adminOnly ?? false,
    }
  },
}
