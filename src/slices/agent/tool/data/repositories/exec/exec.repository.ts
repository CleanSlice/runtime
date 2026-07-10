import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"
import { nonInteractiveEnv } from "./spawnEnv"

const schema = z.object({
  command: z.string().describe("Shell command to execute"),
})

export const ExecTool: Tool = {
  name: "exec",
  description: "Execute a shell command and return stdout/stderr",
  schema,
  adminOnly: true,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { command } = schema.parse(params)
    const proc = Bun.spawn(["sh", "-c", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: nonInteractiveEnv(),
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  },
}
