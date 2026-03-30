import { z } from "zod"
import type { Tool, ToolContext } from "../domain/tool.types"

const schema = z.object({
  command: z.string().describe("Shell command to execute"),
})

export const ExecTool: Tool = {
  name: "exec",
  description: "Execute a shell command and return stdout/stderr",
  schema,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { command } = schema.parse(params)
    const EXEC_TIMEOUT = 90_000 // 90s — under the global 120s tool timeout
    const proc = Bun.spawn(["sh", "-c", command], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => proc.kill(), EXEC_TIMEOUT)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return {
        stdout: stdout.slice(0, 50_000),
        stderr: stderr.slice(0, 10_000),
        exitCode,
      }
    } finally {
      clearTimeout(timer)
    }
  },
}
