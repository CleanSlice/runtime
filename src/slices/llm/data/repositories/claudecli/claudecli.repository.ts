import type { ILlmGateway } from "../../../domain/llm.gateway"
import type { ModelResponse } from "../../../domain/llm.types"
import type { Tool } from "../../../../tool/tool.module"
import type { Event } from "../../../../event"
import { spawn } from "child_process"

/**
 * ClaudeCliRepository — uses the `claude` CLI (Claude Code) to run completions.
 * This bypasses the need for a direct API key — uses the OAuth token the CLI already has.
 */
export class ClaudeCliRepository implements ILlmGateway {
  private cliBin: string
  private model: string

  constructor({ cliBin = "claude", model = "claude-sonnet-4-6" }: {
    cliBin?: string
    model?: string
  } = {}) {
    this.cliBin = cliBin
    this.model = model
  }

  async complete(systemPrompt: string, history: Event[], _tools: Tool[]): Promise<ModelResponse> {
    const lastUser = history.filter(e => e.type === "user").pop()
    const userText = lastUser ? String((lastUser.data as { text?: unknown })?.text ?? lastUser.data) : ""

    // Build conversation context
    const contextLines: string[] = []
    for (const event of history.slice(-10)) { // last 10 events for context
      if (event.type === "user") {
        contextLines.push(`User: ${String((event.data as { text?: unknown })?.text ?? "")}`)
      } else if (event.type === "assistant") {
        contextLines.push(`Assistant: ${String((event.data as { text?: unknown })?.text ?? "")}`)
      }
    }

    const prompt = [
      systemPrompt,
      "",
      ...(contextLines.length > 0 ? ["--- Conversation history ---", ...contextLines, "---", ""] : []),
      `Now respond to the last user message: ${userText}`,
    ].join("\n")

    const text = await this.runCli(prompt)
    return { text }
  }

  private runCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
      }

      console.log(`[claude-cli] spawning with prompt length=${prompt.length}`)

      // Pass prompt via stdin to avoid arg length limits
      const proc = spawn(this.cliBin, [
        "--print",
        "--permission-mode", "bypassPermissions",
        "--model", this.model,
      ], { env })

      let stdout = ""
      let stderr = ""

      proc.stdout.on("data", d => { stdout += d.toString() })
      proc.stderr.on("data", d => { stderr += d.toString() })

      // Write prompt to stdin
      proc.stdin.write(prompt)
      proc.stdin.end()

      proc.on("close", code => {
        console.log(`[claude-cli] exited code=${code} stdout_len=${stdout.length} stderr=${stderr.slice(0,100)}`)
        if (code !== 0) {
          reject(new Error(`claude CLI exited ${code}: ${stderr}`))
        } else {
          resolve(stdout.trim())
        }
      })

      proc.on("error", err => {
        console.error("[claude-cli] spawn error:", err)
        reject(err)
      })
    })
  }
}
