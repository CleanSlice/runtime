import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { MemoryService } from "../../../../memory/domain/memory.service"

const schema = z.object({
  text: z.string().describe("Text to save to daily memory. Include concrete values: names, emails, decisions, results."),
})

export const MemorySaveTool: Tool = {
  name: "memory_save",
  description:
    "Append a note to today's daily memory file (memory/YYYY-MM-DD.md). " +
    "Use this to remember important facts, decisions, user preferences, and action results " +
    "that should persist across sessions. Write concrete values, not summaries.",
  schema,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { text } = schema.parse(params)
    MemoryService.appendDaily(ctx.agentDir, text)
    return { ok: true }
  },
}
