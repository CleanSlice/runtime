import Anthropic from "@anthropic-ai/sdk"
import type { ILlmGateway } from "../../../domain/llm.gateway"
import type { ModelResponse } from "../../../domain/llm.types"
import type { Tool } from "../../../../tool/tool.module"
import type { Event } from "../../../../event"
import { zodToJsonSchema } from "zod-to-json-schema"

// Detect Anthropic overloaded_error — arrives via SSE body with status=undefined
function isOverloadedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const e = err as Record<string, unknown>
  // Direct status 529
  if (e.status === 529) return true
  // SSE error: message or error body contains overloaded_error
  const msg = String(e.message ?? e.error ?? "")
  return msg.includes("overloaded_error") || msg.includes("Overloaded")
}

/**
 * Retry a LLM call up to maxAttempts times with exponential backoff.
 * Returns true if succeeded (result via out param), false if all attempts failed with overload.
 * Throws immediately on non-retryable errors (401, 403, 400).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  label: string
): Promise<{ ok: true; value: T } | { ok: false; lastError: unknown; wasOverloaded: boolean }> {
  let lastError: unknown
  let wasOverloaded = false
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn()
      return { ok: true, value }
    } catch (err: unknown) {
      lastError = err
      const status = (err as { status?: number })?.status
      if (status === 401 || status === 403 || status === 400) throw err
      const overloaded = isOverloadedError(err)
      if (overloaded) wasOverloaded = true
      if (attempt < maxAttempts) {
        const delay = overloaded ? Math.min(5000 * attempt, 60000) : attempt * 2000
        console.warn(`[llm] ${label} attempt ${attempt}/${maxAttempts} failed (${overloaded ? "overloaded" : status ?? "network"}), retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  return { ok: false, lastError, wasOverloaded }
}

export class ClaudeRepository implements ILlmGateway {
  private client: Anthropic
  private model: string
  private fallbackModel: string | undefined

  constructor({ model, apiKey, fallbackModel }: { model: string; apiKey?: string; fallbackModel?: string }) {
    this.model = model
    this.fallbackModel = fallbackModel

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

  async stream(
    systemPrompt: string,
    history: Event[],
    tools: Tool[],
    onChunk: (text: string) => void
  ): Promise<ModelResponse> {
    const messages = this.sanitizeMessages(this.eventsToMessages(history))

    const anthropicTools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.schema) as Anthropic.Tool["input_schema"],
    }))

    const modelsToTry = [this.model]
    if (this.fallbackModel && this.fallbackModel !== this.model) {
      modelsToTry.push(this.fallbackModel)
    }

    let lastError: unknown
    for (const model of modelsToTry) {
      const isFallback = model !== this.model
      if (isFallback) {
        console.warn(`[llm] stream switching to fallback model: ${model}`)
      }

      const result = await withRetry(
        async () => {
          let accumulated = ""
          const toolCalls: Array<{ name: string; params: unknown }> = []
          const pendingTools = new Map<number, { id: string; name: string; jsonStr: string }>()

          const streamResponse = await this.client.messages.stream({
            model,
            max_tokens: 8096,
            system: systemPrompt,
            messages,
            ...(anthropicTools.length > 0 ? { tools: anthropicTools } : {}),
          })

          for await (const event of streamResponse) {
            if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
              pendingTools.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                jsonStr: "",
              })
            } else if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                accumulated += event.delta.text
                onChunk(accumulated)
              } else if (event.delta.type === "input_json_delta") {
                const pending = pendingTools.get(event.index)
                if (pending) pending.jsonStr += event.delta.partial_json
              }
            } else if (event.type === "content_block_stop") {
              const pending = pendingTools.get(event.index)
              if (pending) {
                try {
                  toolCalls.push({ name: pending.name, params: JSON.parse(pending.jsonStr || "{}") })
                } catch {
                  toolCalls.push({ name: pending.name, params: {} })
                }
                pendingTools.delete(event.index)
              }
            }
          }

          return {
            text: accumulated,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          } as ModelResponse
        },
        7,
        `stream[${model}]`
      )

      if (result.ok) return result.value
      lastError = result.lastError
      // Only try fallback if primary failed due to overload
      if (!result.wasOverloaded) break
    }
    throw lastError
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

    const modelsToTry = [this.model]
    if (this.fallbackModel && this.fallbackModel !== this.model) {
      modelsToTry.push(this.fallbackModel)
    }

    let lastError: unknown
    for (const model of modelsToTry) {
      const isFallback = model !== this.model
      if (isFallback) {
        console.warn(`[llm] complete switching to fallback model: ${model}`)
      }

      const result = await withRetry(
        async () => {
          const response = await this.client.messages.create({
            model,
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

          return { text, toolCalls: toolCalls.length > 0 ? toolCalls : undefined } as ModelResponse
        },
        7,
        `complete[${model}]`
      )

      if (result.ok) return result.value
      lastError = result.lastError
      // Only try fallback if primary failed due to overload
      if (!result.wasOverloaded) break
    }
    throw lastError
  }

  // Repair history before sending to API:
  // 1. Every tool_use must be immediately followed by a tool_result
  // 2. Orphan tool_results (no matching tool_use) are removed
  // 3. Consecutive same-role messages are merged
  private sanitizeMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    // Anthropic requires the last message to be from "user" — remove trailing assistant messages
    while (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      messages.pop()
    }
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
        // Inject as system-style user note — no fake assistant reply to avoid
        // "conversation must end with user message" errors during compaction
        messages.push({
          role: "user",
          content: `[ARCHIVED CONTEXT — background info only, do not assume actions were already performed]\n\n${text}\n\n[END ARCHIVED CONTEXT]`,
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
