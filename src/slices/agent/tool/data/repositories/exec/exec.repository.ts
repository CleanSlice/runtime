import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  command: z.string().describe("Shell command to execute"),
})

export const ExecTool: Tool = {
  name: "exec",
  description: "Execute a shell command and return stdout/stderr",
  schema,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { command } = schema.parse(params)
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  },
}
