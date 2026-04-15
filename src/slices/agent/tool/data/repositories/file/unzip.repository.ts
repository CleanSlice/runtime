import { z } from "zod"
import { execSync } from "child_process"
import path from "path"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  path: z.string().describe("Path to the zip archive"),
  outputDir: z.string().optional().describe("Directory to extract into (defaults to same directory as the zip file)"),
})

export const UnzipTool: Tool = {
  name: "unzip",
  description: "Extract a zip archive to a directory. Use when the user sends a zip file.",
  schema,
  adminOnly: true,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { path: zipPath, outputDir } = schema.parse(params)
    const dest = outputDir ?? path.dirname(zipPath)
    const output = execSync(`unzip -o ${JSON.stringify(zipPath)} -d ${JSON.stringify(dest)}`, { encoding: "utf8" })
    const files = output
      .split("\n")
      .filter(line => line.trimStart().startsWith("inflating:") || line.trimStart().startsWith("extracting:"))
      .map(line => line.replace(/^\s*(inflating|extracting):\s*/, "").trim())
    return { outputDir: dest, files }
  },
}
