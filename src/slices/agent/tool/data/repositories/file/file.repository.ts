import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  action: z.enum(["read", "write"]),
  path: z.string().describe("File path"),
  content: z.string().optional().describe("Content to write (for write action)"),
})

export const FileTool: Tool = {
  name: "file",
  description: "Read or write files on the filesystem",
  schema,
  adminOnly: true,
  // Basename only — full paths are agent internals (FR-008).
  stepLabel(params: unknown): string | undefined {
    const p = schema.safeParse(params)
    if (!p.success) return undefined
    const base = p.data.path.split("/").filter(Boolean).pop()
    if (!base) return undefined
    return `${p.data.action === "read" ? "Read" : "Write"} ${base}`
  },
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { action, path, content } = schema.parse(params)
    if (action === "read") {
      const text = await Bun.file(path).text()
      return { content: text }
    } else {
      await Bun.write(path, content ?? "")
      return { success: true, path }
    }
  },
}
