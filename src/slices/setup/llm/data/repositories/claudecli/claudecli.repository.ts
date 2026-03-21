import type { ILlmGateway } from "../../../domain/llm.gateway"
import type { ModelResponse } from "../../../domain/llm.types"
import type { Tool } from "../../../../../agent/tool/tool.module"
import type { Event } from "../../../../../agent/event"
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
    const lastUser = history.filter(e => e.type === "user").pop()
    const userText = String((lastUser?.data as { text?: unknown })?.text ?? "")

    // Step 1: if tools available, first ask a focused dispatcher to check if tool needed
    if (tools.length > 0) {
      const toolList = tools.map(t => `- ${t.name}: ${t.description}`).join("\n")
      const dispatchPrompt = `You are a tool dispatcher. Given the user message and available tools, decide if a tool should be called.

Available tools:
${toolList}

User message: "${userText}"

If a tool should be called, respond with ONLY this JSON (no other text):
{"tool": "tool_name", "params": {...}}

If no tool is needed, respond with exactly: NO_TOOL`

      const dispatchResult = await this.runCli(dispatchPrompt)
      const trimmed = dispatchResult.trim()

      if (trimmed !== "NO_TOOL" && trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed) as { tool: string; params: unknown }
          if (parsed.tool && tools.find(t => t.name === parsed.tool)) {
            return {
              text: "",
              toolCalls: [{ name: parsed.tool, params: parsed.params }],
            }
          }
        } catch {
          // not valid JSON, fall through to normal response
        }
      }
    }

    // Step 2: normal response with context
    const contextLines: string[] = []
    for (const event of history.slice(-8)) {
      if (event.type === "user") {
        contextLines.push(`User: ${String((event.data as { text?: unknown })?.text ?? "")}`)
      } else if (event.type === "assistant") {
        contextLines.push(`Assistant: ${String((event.data as { text?: unknown })?.text ?? "")}`)
      }
    }

    const prompt = [
      systemPrompt,
      "",
      ...(contextLines.length > 1 ? contextLines.slice(0, -1) : []),
      contextLines[contextLines.length - 1] ?? "",
    ].join("\n")

    const text = await this.runCli(prompt)
    return { text }
  }

  private runCli(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
      if (!oauthToken) return reject(new Error("CLAUDE_CODE_OAUTH_TOKEN not set"))

      const env = {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        HOME: process.env.HOME ?? "/home/dmitriyzhuk",
      }

      const proc = spawn(this.cliBin, [
        "--print",
        "--permission-mode", "bypassPermissions",
        "--model", this.model,
      ], { env, stdio: ["pipe", "pipe", "pipe"] })

      proc.stdin.write(prompt)
      proc.stdin.end()

      let stdout = ""
      const timer = setTimeout(() => { proc.kill(); reject(new Error("claude CLI timeout after 120s")) }, 120_000)

      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on("data", (_d: Buffer) => {})

      proc.on("close", (code: number) => {
        clearTimeout(timer)
        console.log(`[claude-cli] done code=${code} len=${stdout.length}`)
        if (code !== 0) reject(new Error(`claude CLI exited ${code}`))
        else resolve(stdout.trim())
      })

      proc.on("error", (err: Error) => { clearTimeout(timer); reject(err) })
    })
  }
}
