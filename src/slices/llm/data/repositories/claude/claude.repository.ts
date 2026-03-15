import Anthropic from "@anthropic-ai/sdk"
import type { ILlmGateway } from "../../../domain/llm.gateway"
import type { ModelResponse } from "../../../domain/llm.types"
import type { Tool } from "../../../../tool/tool.module"
import type { Event } from "../../../../event"
import { zodToJsonSchema } from "zod-to-json-schema"

export class ClaudeRepository implements ILlmGateway {
  private client: Anthropic
  private model: string

  constructor({ model, apiKey }: { model: string; apiKey?: string }) {
    this.model = model

    const key = apiKey ?? process.env.ANTHROPIC_API_KEY
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN

    if (oauthToken && !key) {
      // OAuth token with beta header — works with Claude.ai subscription
      this.client = new Anthropic({
        authToken: oauthToken,
        defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
      })
    } else {
      // Standard API key (sk-ant-api03-...)
      this.client = new Anthropic({ apiKey: key })
    }
  }

  async complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse> {
    const messages = this.sanitizeMessages(this.eventsToMessages(history))

    const anthropicTools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.schema) as Anthropic.Tool["input_schema"],
    }))

    // Retry up to 3 times on transient errors (5xx, network, 429)
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await this.client.messages.create({
          model: this.model,
          max_tokens: 8096,
          system: systemPrompt,
          messages,
          ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
        })

        const text = response.content
          .filter(b => b.type === "text")
          .map(b => (b as Anthropic.TextBlock).text)
          .join("")

        const toolCalls = response.content
          .filter(b => b.type === "tool_use")
          .map(b => {
            const block = b as Anthropic.ToolUseBlock
            return { name: block.name, params: block.input }
          })

        return { text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
      } catch (err: unknown) {
        lastError = err
        const status = (err as { status?: number })?.status
        // Don't retry on auth errors (401, 403) or bad request (400)
        if (status === 401 || status === 403 || status === 400) throw err
        if (attempt < 3) {
          const delay = attempt * 2000 // 2s, 4s
          console.warn(`[llm] attempt ${attempt} failed (${status ?? "network"}), retrying in ${delay}ms...`)
          await new Promise(r => setTimeout(r, delay))
        }
      }
    }
    throw lastError
  }

  // Repair history before sending to API:
  // 1. Every tool_use must be immediately followed by a tool_result
  // 2. Orphan tool_results (no matching tool_use) are removed
  // 3. Consecutive same-role messages are merged
  private sanitizeMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    // Index tool_results by tool_use_id for lookup
    const resultIndex = new Map<string, Anthropic.ToolResultBlockParam>()
    for (const msg of messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type: string }>) {
          if (block.type === "tool_result") {
            const b = block as Anthropic.ToolResultBlockParam
            resultIndex.set(b.tool_use_id, b)
          }
        }
      }
    }

    // Track which tool_use_ids have been placed
    const placed = new Set<string>()
    const result: Anthropic.MessageParam[] = []

    for (const msg of messages) {
      // Skip user messages that are purely orphan tool_results
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const nonOrphan = (msg.content as Array<{ type: string }>).filter(b => {
          if (b.type !== "tool_result") return true
          const id = (b as Anthropic.ToolResultBlockParam).tool_use_id
          return !placed.has(id) // keep only if not already placed
        })
        if (nonOrphan.length === 0) continue
        result.push({ role: "user", content: nonOrphan as Anthropic.ContentBlockParam[] })
        continue
      }

      result.push(msg)

      // After assistant tool_use — ensure tool_result immediately follows
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const toolUseBlocks = (msg.content as Array<{ type: string }>)
          .filter(b => b.type === "tool_use") as Anthropic.ToolUseBlock[]

        if (toolUseBlocks.length === 0) continue

        // Build tool_result message for all tool_use blocks
        const resultBlocks: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map(b => {
          placed.add(b.id)
          const existing = resultIndex.get(b.id)
          if (existing) return existing
          // Synthetic fallback
          console.warn(`[llm] inserting synthetic result for tool_use id=${b.id.slice(0, 8)}`)
          return {
            type: "tool_result" as const,
            tool_use_id: b.id,
            content: "Tool execution was interrupted",
          }
        })

        // Check if next message already has these results
        const nextIdx = result.length // result already has current msg pushed
        // We always insert — duplicates filtered above via placed set
        result.push({ role: "user", content: resultBlocks })
      }
    }

    return result
  }

  private eventsToMessages(events: Event[]): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = []

    for (const event of events) {
      if (event.type === "summary") {
        const text = String((event.data as { text?: unknown })?.text ?? "")
        // Inject as user note so the assistant treats it as background info, not its own actions
        messages.push({
          role: "user",
          content: `[NOTE: This is an archived summary of earlier conversation. Treat it as background context only — do not assume you already performed any actions mentioned here.]\n\n${text}`,
        })
        messages.push({
          role: "assistant",
          content: "Understood, I have the archived context as background information.",
        })
      } else if (event.type === "user") {
        messages.push({ role: "user", content: String((event.data as { text?: unknown })?.text ?? event.data) })
      } else if (event.type === "assistant") {
        messages.push({ role: "assistant", content: String((event.data as { text?: unknown })?.text ?? event.data) })
      } else if (event.type === "tool_call") {
        const d = event.data as { name: string; params: unknown; toolUseId: string }
        messages.push({
          role: "assistant",
          content: [{ type: "tool_use", id: d.toolUseId, name: d.name, input: d.params as Record<string, unknown> }],
        })
      } else if (event.type === "tool_result") {
        const d = event.data as { toolUseId: string; result: unknown }
        messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: d.toolUseId, content: JSON.stringify(d.result) }],
        })
      }
    }

    return messages
  }
}
