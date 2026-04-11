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
