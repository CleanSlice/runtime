import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  task: z.string().describe("Task description for the Claude Code agent to handle"),
  workdir: z.string().optional().default(".").describe("Working directory for the agent (default: current directory)"),
  notify_chat_id: z.string().optional().describe("Telegram chat ID to send the result to when done"),
})

export const SpawnAgentTool: Tool = {
  name: "spawn_agent",

  effect: "write",
  description: "Spawn an external Claude Code coding agent (a separate process with its own credentials) for a software task in a repository. For sub-tasks of your own work that only need your tools, use delegate_task instead — it runs isolated workers inside this runtime and returns their summaries to you.",
  schema,
  adminOnly: true,
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { task, workdir, notify_chat_id } = schema.parse(params)

    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (!token) {
      return { error: "CLAUDE_CODE_OAUTH_TOKEN environment variable is not set" }
    }

    const claudeBin = "/home/dmitriyzhuk/.local/bin/claude"

    const proc = Bun.spawn(
      [claudeBin, "--print", "--permission-mode", "bypassPermissions", task],
      {
        stdout: "pipe",
        stderr: "pipe",
        cwd: workdir ?? ".",
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
      }
    )

    const timeoutMs = (ctx.agentConfig?.tools.spawnAgent.timeoutMin ?? 5) * 60 * 1000
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Agent timed out after 5 minutes")), timeoutMs)
    )

    let output: string
    let exitCode: number

    try {
      const [stdout, , code] = await Promise.race([
        Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]),
        timeoutPromise,
      ])
      output = stdout
      exitCode = code
    } catch (err) {
      proc.kill()
      return { error: String(err) }
    }

    if (notify_chat_id) {
      const telegramToken = process.env.TELEGRAM_BOT_TOKEN
      if (telegramToken) {
        const outputLimit = ctx.agentConfig?.tools.spawnAgent.outputLimit ?? 4000
        const summary = output.slice(0, outputLimit) || "(no output)"
        await fetch(`https://api.telegram.org/bot${telegramToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: notify_chat_id,
            text: `Agent done (exit ${exitCode}):\n\n${summary}`,
          }),
        }).catch(() => {})
      }
    }

    return { output, exitCode }
  },
}
