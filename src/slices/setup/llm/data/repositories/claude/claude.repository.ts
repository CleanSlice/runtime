import type Anthropic from "@anthropic-ai/sdk"
import type { ILlmGateway } from "../../../domain/llm.gateway"
import type { ModelResponse } from "../../../domain/llm.types"
import type { Tool } from "../../../../../agent/tool/tool.module"
import type { Event } from "../../../../../agent/event"
import { zodToJsonSchema } from "zod-to-json-schema"

let _AnthropicClass: (new (opts: Record<string, unknown>) => Anthropic) | undefined

async function getAnthropic(): Promise<(new (opts: Record<string, unknown>) => Anthropic)> {
  if (!_AnthropicClass) {
    const mod = await import("@anthropic-ai/sdk")
    _AnthropicClass = mod.default as unknown as (new (opts: Record<string, unknown>) => Anthropic)
  }
  return _AnthropicClass
}

// --- Alert: notify admin via Telegram when token fails ---
let lastAlertAt = 0
async function sendAdminAlert(message: string): Promise<void> {
  const adminId = process.env.TELEGRAM_BOT_ADMIN_IDS?.split(",")[0]
  const botToken = process.env.TELEGRAM_BOT_TOKEN
  if (!adminId || !botToken) return
  // Rate limit: max 1 alert per 10 minutes
  const now = Date.now()
  if (now - lastAlertAt < 10 * 60 * 1000) return
  lastAlertAt = now
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: adminId, text: `🚨 Bot LLM Alert\n\n${message}`, parse_mode: "Markdown" }),
    })
    console.warn(`[llm] admin alert sent: ${message}`)
  } catch (e) {
    console.error("[llm] failed to send admin alert:", e)
  }
}

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
): Promise<{ ok: true; value: T } | { ok: false; lastError: unknown; wasOverloaded: boolean; wasBadRequest: boolean }> {
  let lastError: unknown
  let wasOverloaded = false
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn()
      return { ok: true, value }
    } catch (err: unknown) {
      lastError = err
      const status = (err as { status?: number })?.status
      if (status === 401 || status === 403) throw err
      // 400 = model not available or bad request — stop retrying, let caller try fallback
      if (status === 400) {
        console.warn(`[llm] ${label} got 400 (model unavailable?), will try fallback`)
        return { ok: false, lastError: err, wasOverloaded: false, wasBadRequest: true }
      }
      const overloaded = isOverloadedError(err)
      if (overloaded) wasOverloaded = true
      if (attempt < maxAttempts) {
        const delay = overloaded ? Math.min(5000 * attempt, 60000) : attempt * 2000
        console.warn(`[llm] ${label} attempt ${attempt}/${maxAttempts} failed (${overloaded ? "overloaded" : status ?? "network"}), retrying in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }
  return { ok: false, lastError, wasOverloaded, wasBadRequest: false }
}

// How long to stay on fallback before retrying primary (ms)
const PRIMARY_RETRY_AFTER_MS = 2 * 60 * 1000 // 2 minutes

export class ClaudeRepository implements ILlmGateway {
  private clients: Anthropic[] = []   // OAuth pool (index 0 = primary, 1,2... = fallbacks)
  private apiKeyClient: Anthropic | undefined  // API key client (last resort)
  private currentClientIndex = 0
  private model: string
  private fallbackModel: string | undefined
  private apiKey: string | undefined
  private initialized = false
  // Circuit breaker: timestamp when primary was last marked overloaded (0 = healthy)
  private primaryOverloadedAt = 0

  constructor({ model, apiKey, fallbackModel }: { model: string; apiKey?: string; fallbackModel?: string }) {
    this.model = model
    this.fallbackModel = fallbackModel
    this.apiKey = apiKey
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    const AnthropicCtor = await getAnthropic()

    // Build OAuth client pool from CLAUDE_CODE_OAUTH_TOKEN (comma-separated or single)
    // Also supports legacy CLAUDE_CODE_OAUTH_TOKEN_2, _3... for backwards compat
    const oauthTokens: string[] = []
    const t0 = process.env.CLAUDE_CODE_OAUTH_TOKEN
    if (t0) {
      // Support comma-separated list: token1,token2,token3
      oauthTokens.push(...t0.split(",").map(t => t.trim()).filter(Boolean))
    }
    for (let i = 2; i <= 10; i++) {
      const t = process.env[`CLAUDE_CODE_OAUTH_TOKEN_${i}`]
      if (t) oauthTokens.push(t.trim())
    }

    this.clients = oauthTokens.map(token => new AnthropicCtor({
      authToken: token,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20,claude-code-20250219" },
    }))

    // API key as final fallback
    const key = this.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (key) {
      this.apiKeyClient = new AnthropicCtor({ apiKey: key })
    }

    if (this.clients.length === 0 && this.apiKeyClient) {
      // Only API key — use it as primary
      this.clients = [this.apiKeyClient]
      this.apiKeyClient = undefined
    }

  }

  /** Get current active client */
  private getClient(): Anthropic {
    return this.clients[this.currentClientIndex] ?? this.clients[0]
  }

  /** Switch to next OAuth token or API key fallback. Returns true if switched. */
  private switchToNextClient(failedStatus: number): boolean {
    const nextIndex = this.currentClientIndex + 1
    if (nextIndex < this.clients.length) {
      console.warn(`[llm] OAuth token[${this.currentClientIndex}] failed (${failedStatus}), switching to token[${nextIndex}]`)
      void sendAdminAlert(`⚠️ OAuth token #${this.currentClientIndex + 1} failed (${failedStatus})\n\nСвитчнулся на токен #${nextIndex + 1}. Осталось токенов: ${this.clients.length - nextIndex}`)
      this.currentClientIndex = nextIndex
      return true
    }
    if (this.apiKeyClient) {
      console.warn(`[llm] all OAuth tokens exhausted, switching to API key fallback`)
      void sendAdminAlert(`🚨 Все OAuth токены исчерпаны!\n\nИспользую API key fallback. Обнови токены в .env`)
      // Replace current with apiKeyClient
      this.clients[this.currentClientIndex] = this.apiKeyClient
      this.apiKeyClient = undefined
      return true
    }
    return false
  }

  /** Returns [primary, fallback?] respecting circuit breaker state */
  private getModelsToTry(): string[] {
    if (!this.fallbackModel || this.fallbackModel === this.model) return [this.model]
    const now = Date.now()
    if (this.primaryOverloadedAt > 0) {
      const elapsed = now - this.primaryOverloadedAt
      if (elapsed < PRIMARY_RETRY_AFTER_MS) {
        // Primary still in cooldown — skip straight to fallback
        console.warn(`[llm] primary overloaded ${Math.round(elapsed / 1000)}s ago, using fallback directly (retry in ${Math.round((PRIMARY_RETRY_AFTER_MS - elapsed) / 1000)}s)`)
        return [this.fallbackModel]
      } else {
        // Cooldown expired — try primary again
        console.log(`[llm] primary cooldown expired, retrying primary model`)
        this.primaryOverloadedAt = 0
      }
    }
    return [this.model, this.fallbackModel]
  }

  async stream(
    systemPrompt: string,
    history: Event[],
    tools: Tool[],
    onChunk: (text: string) => void
  ): Promise<ModelResponse> {
    await this.ensureInitialized()
    const messages = this.sanitizeMessages(this.eventsToMessages(history))

    const anthropicTools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.schema) as Anthropic.Tool["input_schema"],
    }))

    const modelsToTry = this.getModelsToTry()

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
          let streamUsage: { input_tokens: number; output_tokens: number } | undefined

          const streamResponse = await this.getClient().messages.stream({
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
            } else if (event.type === "message_delta" && (event as any).usage) {
              streamUsage = (event as any).usage
            } else if (event.type === "message_start" && (event as any).message?.usage) {
              streamUsage = (event as any).message.usage
            }
          }

          return {
            text: accumulated,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: streamUsage ? {
              inputTokens: streamUsage.input_tokens,
              outputTokens: streamUsage.output_tokens,
              totalTokens: streamUsage.input_tokens + streamUsage.output_tokens,
              credentialId: `oauth-${this.currentClientIndex}`,
            } : undefined,
          } as ModelResponse
        },
        7,
        `stream[${model}]`
      )

      if (result.ok) {
        if (model === this.model && this.primaryOverloadedAt > 0) {
          console.log(`[llm] primary model recovered, resetting circuit breaker`)
          this.primaryOverloadedAt = 0
        }
        return result.value
      }
      lastError = result.lastError
      const status = (lastError as { status?: number })?.status
      // Auth error → try next OAuth token or API key
      if (status === 401 || status === 403) {
        if (this.switchToNextClient(status)) continue
        void sendAdminAlert(`🚨 Auth error ${status} — все fallback-ы исчерпаны. Бот не работает!`)
        break
      }
      if (model === this.model && result.wasOverloaded) {
        this.primaryOverloadedAt = Date.now()
        console.warn(`[llm] primary overloaded, circuit breaker tripped (retry in ${PRIMARY_RETRY_AFTER_MS / 1000}s)`)
      } else if (result.wasBadRequest) {
        // 400 = model unavailable — continue to fallback model
        console.warn(`[llm] model ${model} unavailable (400), trying next`)
      } else if (!result.wasOverloaded) {
        break
      }
    }
    throw lastError
  }

  async complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse> {
    await this.ensureInitialized()
    const messages = this.sanitizeMessages(this.eventsToMessages(history))

    const anthropicTools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.schema) as Anthropic.Tool["input_schema"],
    }))

    const modelsToTry = this.getModelsToTry()

    let lastError: unknown
    for (const model of modelsToTry) {
      const isFallback = model !== this.model
      if (isFallback) {
        console.warn(`[llm] complete switching to fallback model: ${model}`)
      }

      const result = await withRetry(
        async () => {
          const response = await this.getClient().messages.create({
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

          return {
            text,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            usage: response.usage ? {
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.input_tokens + response.usage.output_tokens,
              credentialId: `oauth-${this.currentClientIndex}`,
            } : undefined,
          } as ModelResponse
        },
        7,
        `complete[${model}]`
      )

      if (result.ok) {
        if (model === this.model && this.primaryOverloadedAt > 0) {
          console.log(`[llm] primary model recovered, resetting circuit breaker`)
          this.primaryOverloadedAt = 0
        }
        return result.value
      }
      lastError = result.lastError
      const status = (lastError as { status?: number })?.status
      // Auth error → try next OAuth token or API key
      if (status === 401 || status === 403) {
        if (this.switchToNextClient(status)) continue
        void sendAdminAlert(`🚨 Auth error ${status} — все fallback-ы исчерпаны. Бот не работает!`)
        break
      }
      if (model === this.model && result.wasOverloaded) {
        this.primaryOverloadedAt = Date.now()
        console.warn(`[llm] primary overloaded, circuit breaker tripped (retry in ${PRIMARY_RETRY_AFTER_MS / 1000}s)`)
      } else if (result.wasBadRequest) {
        // 400 = model unavailable — continue to fallback model
        console.warn(`[llm] model ${model} unavailable (400), trying next`)
      } else if (!result.wasOverloaded) {
        break
      }
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

    // Pre-scan: collect all tool_use IDs that exist in assistant messages
    const knownToolUseIds = new Set<string>()
    for (const msg of messages) {
      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type: string }>) {
          if (block.type === "tool_use") {
            knownToolUseIds.add((block as Anthropic.ToolUseBlock).id)
          }
        }
      }
    }

    // Index tool_results by tool_use_id for lookup (only those with a matching tool_use)
    const resultIndex = new Map<string, Anthropic.ToolResultBlockParam>()
    for (const msg of messages) {
      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content as Array<{ type: string }>) {
          if (block.type === "tool_result") {
            const b = block as Anthropic.ToolResultBlockParam
            if (knownToolUseIds.has(b.tool_use_id)) {
              resultIndex.set(b.tool_use_id, b)
            }
          }
        }
      }
    }

    // Track which tool_use_ids have been placed as results
    const placed = new Set<string>()
    const result: Anthropic.MessageParam[] = []

    for (const msg of messages) {
      // Filter user messages: remove tool_results that are orphans or already placed
      if (msg.role === "user" && Array.isArray(msg.content)) {
        const filtered = (msg.content as Array<{ type: string }>).filter(b => {
          if (b.type !== "tool_result") return true
          const id = (b as Anthropic.ToolResultBlockParam).tool_use_id
          // Drop if no matching tool_use exists, or if already placed inline
          if (!knownToolUseIds.has(id)) return false
          if (placed.has(id)) return false
          return true
        })
        if (filtered.length === 0) continue
        result.push({ role: "user", content: filtered as Anthropic.ContentBlockParam[] })
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
          console.warn(`[llm] ⚠ synthetic result for interrupted tool_use`)
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
