import type { ILlmGateway } from "../../../domain/llm.gateway"
import type { ModelResponse } from "../../../domain/llm.types"
import type { Tool } from "../../../../tool/tool.module"
import type { Event } from "../../../../event"
import { spawn } from "child_process"

export class ClaudeCliRepository implements ILlmGateway {
  private cliBin: string
  private model: string

  constructor({ cliBin = "/home/dmitriyzhuk/.local/bin/claude", model = "claude-sonnet-4-6" }: {
    cliBin?: string
    model?: string
  } = {}) {
    this.cliBin = cliBin
    this.model = model
  }

  async complete(systemPrompt: string, history: Event[], tools: Tool[]): Promise<ModelResponse> {
    const contextLines: string[] = []
    for (const event of history.slice(-10)) {
      if (event.type === "user") {
        contextLines.push(`User: ${String((event.data as { text?: unknown })?.text ?? "")}`)
      } else if (event.type === "assistant") {
        contextLines.push(`Assistant: ${String((event.data as { text?: unknown })?.text ?? "")}`)
      }
    }

    // Describe available tools — placed at the END of prompt for better compliance
    let toolsSection = ""
    if (tools.length > 0) {
      const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join("\n")
      toolsSection = `\n\n## Tools\nIf the user asks you to perform an action, use a tool. Respond ONLY with this format (no other text):\nTOOL_CALL: {"tool": "tool_name", "params": {...}}\n\nAvailable:\n${toolList}`
    }

    const prompt = [
      systemPrompt,
      "",
      ...(contextLines.length > 1 ? ["--- Conversation ---", ...contextLines.slice(0, -1), "---", ""] : []),
      contextLines[contextLines.length - 1] ?? "",
      toolsSection,
    ].join("\n")

    const text = await this.runCli(prompt)

    // Parse tool call if present
    const toolCallMatch = text.match(/^TOOL_CALL:\s*(\{.+\})/m)
    if (toolCallMatch) {
      try {
        const parsed = JSON.parse(toolCallMatch[1]) as { tool: string; params: unknown }
        return {
          text: text.replace(/^TOOL_CALL:.+$/m, "").trim(),
          toolCalls: [{ name: parsed.tool, params: parsed.params }],
        }
      } catch {
        // not valid JSON, treat as plain text
      }
    }

    return { text }
  }

  private runCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
      if (!oauthToken) {
        return reject(new Error("CLAUDE_CODE_OAUTH_TOKEN env var not set"))
      }

      const env = {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        HOME: process.env.HOME ?? "/home/dmitriyzhuk",
      }

      console.log(`[claude-cli] spawning prompt_len=${prompt.length}`)

      // Pass prompt via stdin — avoids arg-length issues and TTY hang
      const proc = spawn(this.cliBin, [
        "--print",
        "--permission-mode", "bypassPermissions",
        "--model", this.model,
      ], { env, stdio: ["pipe", "pipe", "pipe"] })

      proc.stdin.write(prompt)
      proc.stdin.end()

      let stdout = ""
      let stderr = ""

      const timer = setTimeout(() => {
        proc.kill()
        reject(new Error("claude CLI timeout after 120s"))
      }, 120_000)

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString() })

      proc.on("close", (code: number) => {
        clearTimeout(timer)
        console.log(`[claude-cli] done code=${code} stdout_len=${stdout.length} stderr=${stderr.slice(0,100)}`)
        if (code !== 0) {
          reject(new Error(`claude CLI exited ${code}: ${stderr.slice(0, 300)}`))
        } else {
          resolve(stdout.trim())
        }
      })

      proc.on("error", (err: Error) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}
