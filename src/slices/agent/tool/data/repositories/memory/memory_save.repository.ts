import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { MemoryService } from "../../../../memory/domain/memory.service"

const schema = z.object({
  text: z.string().describe(
    "Note to save. Start each line with a tag: " +
    "[fact] for stable info (emails, accounts, preferences), " +
    "[event] for what happened (sent email, deployed, error resolved), " +
    "[workflow] for reusable steps (how to deploy, how to set up Gmail). " +
    "Include concrete values. Example: '[fact] User Gmail: user@gmail.com'"
  ),
})

export const MemorySaveTool: Tool = {
  name: "memory_save",
  description:
    "Append a note to today's daily memory file (memory/YYYY-MM-DD.md). " +
    "Use ONLY for durable facts, significant events, and reusable workflows. " +
    "Do NOT save greetings, small talk, resolved errors, or tool call mechanics.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { text } = schema.parse(params)
    MemoryService.appendDaily(ctx.agentDir, text)
    return { ok: true }
  },
}
