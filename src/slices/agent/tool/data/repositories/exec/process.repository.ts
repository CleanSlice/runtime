import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  action: z.enum(["start", "status", "output", "kill"]).describe("Action to perform on the process"),
  command: z.string().optional().describe("Shell command to run (required for action=start)"),
  pid: z.number().optional().describe("Process ID (required for action=status/output/kill)"),
})

interface ProcessEntry {
  proc: ReturnType<typeof Bun.spawn>
  stdout: string
  stderr: string
}

const processes = new Map<number, ProcessEntry>()

export const ProcessExecTool: Tool = {
  name: "process_exec",
  description: "Run a shell command in the background and get its output later. Useful for long-running commands.",
  schema,
  adminOnly: true,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { action, command, pid } = schema.parse(params)

    if (action === "start") {
      if (!command) return { error: "command is required for action=start" }

      const proc = Bun.spawn(["sh", "-c", command], {
        stdout: "pipe",
        stderr: "pipe",
      })

      const entry: ProcessEntry = { proc, stdout: "", stderr: "" }
      const procPid = proc.pid
      processes.set(procPid, entry)

      // Collect output asynchronously
      new Response(proc.stdout).text().then(text => {
        const e = processes.get(procPid)
        if (e) e.stdout += text
      }).catch(() => {})

      new Response(proc.stderr).text().then(text => {
        const e = processes.get(procPid)
        if (e) e.stderr += text
      }).catch(() => {})

      return { pid: procPid, started: true }
    }

    if (!pid) return { error: "pid is required for action=status/output/kill" }
    const entry = processes.get(pid)
    if (!entry) return { error: `No process found with pid=${pid}` }

    if (action === "status") {
      const running = entry.proc.exitCode === null
      return { pid, running, exitCode: entry.proc.exitCode }
    }

    if (action === "output") {
      return { pid, stdout: entry.stdout, stderr: entry.stderr }
    }

    if (action === "kill") {
      entry.proc.kill()
      processes.delete(pid)
      return { pid, killed: true }
    }

    return { error: `Unknown action: ${action}` }
  },
}
