import type { ILlmGateway } from "../../../domain/llm.gateway"
import type { ModelResponse } from "../../../domain/llm.types"
import type { Tool } from "../../../../../agent/tool/tool.module"
import type { Event } from "../../../../event"
import { zodToJsonSchema } from "zod-to-json-schema"

// Gemini's native API is structurally different from Chat Completions:
// - roles are "user" / "model" (not assistant)
// - system prompt lives in a separate `systemInstruction` field
// - tool calls / results are `functionCall` / `functionResponse` parts inside
//   a content turn (no separate tool role, no tool_call_id matching by id —
//   Gemini matches function calls to responses by name + ordering)
// - consecutive same-role turns are invalid: parts of the same role must be
//   merged into one content entry
//
// We still implement ILlmGateway (text, toolCalls, usage, stopReason) so the
// rest of the runtime stays provider-agnostic.

interface GeminiPart {
  text?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

interface GeminiContent {
  role: "user" | "model"
  parts: GeminiPart[]
}

interface GeminiTool {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>
  }>
}

interface GeminiResponseChunk {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
  }
}

export interface GoogleConfig {
  apiKey: string
  model: string
  baseUrl?: string
  maxTokens?: number
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"

// Gemini's tool/function parameter schema is a tightly constrained subset of
// OpenAPI 3.0 — anything outside this allow-list is rejected with 400. The
// most common offenders from zod-to-json-schema: `additionalProperties`,
// `$schema`, `$ref`, `$defs`, `oneOf`/`allOf`/`not`, `const`. Strip them all.
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "properties",
  "required",
  "items",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "title",
])

function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (schema === null || typeof schema !== "object") return schema
  if (Array.isArray(schema)) return schema.map(sanitizeSchemaForGemini)

  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue
    if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {}
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        props[pk] = sanitizeSchemaForGemini(pv)
      }
      out[key] = props
    } else if (key === "items") {
      out[key] = sanitizeSchemaForGemini(value)
    } else {
      out[key] = value
    }
  }
  return out
}

export class GoogleRepository implements ILlmGateway {
  private config: Required<GoogleConfig>

  constructor(config: GoogleConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      maxTokens: config.maxTokens ?? 8192,
    }
  }

  async complete(systemPrompt: string, history: Event[], tools: Tool[]): Promise<ModelResponse> {
    const body = this.buildBody(systemPrompt, history, tools)
    const url = `${this.config.baseUrl}/v1beta/models/${this.config.model}:generateContent`

    const res = await fetch(url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`google API error: ${res.status} ${text}`)
    }

    const data = (await res.json()) as GeminiResponseChunk
    return this.buildResponse(data)
  }

  async stream(
    systemPrompt: string,
    history: Event[],
    tools: Tool[],
    onChunk: (text: string) => void,
  ): Promise<ModelResponse> {
    const body = this.buildBody(systemPrompt, history, tools)
    const url = `${this.config.baseUrl}/v1beta/models/${this.config.model}:streamGenerateContent?alt=sse`

    const res = await fetch(url, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`google API error: ${res.status} ${text}`)
    }

    let accumulatedText = ""
    const toolCalls: Array<{ name: string; params: unknown }> = []
    let finishReason: string | undefined
    let usage: GeminiResponseChunk["usageMetadata"] | undefined

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith("data: ")) continue
        const payload = trimmed.slice(6)

        const chunk = JSON.parse(payload) as GeminiResponseChunk
        const candidate = chunk.candidates?.[0]
        if (!candidate) {
          if (chunk.usageMetadata) usage = chunk.usageMetadata
          continue
        }

        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            accumulatedText += part.text
            onChunk(accumulatedText)
          }
          if (part.functionCall) {
            toolCalls.push({
              name: part.functionCall.name,
              params: part.functionCall.args ?? {},
            })
          }
        }

        if (candidate.finishReason) finishReason = candidate.finishReason
        if (chunk.usageMetadata) usage = chunk.usageMetadata
      }
    }

    return {
      text: accumulatedText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: this.mapStopReason(finishReason, toolCalls.length > 0),
      usage: usage
        ? {
            inputTokens: usage.promptTokenCount ?? 0,
            outputTokens: usage.candidatesTokenCount ?? 0,
            totalTokens: usage.totalTokenCount ?? 0,
            credentialId: "google",
            model: this.config.model,
          }
        : undefined,
    }
  }

  private buildBody(systemPrompt: string, history: Event[], tools: Tool[]): Record<string, unknown> {
    const body: Record<string, unknown> = {
      contents: this.buildContents(history),
      generationConfig: { maxOutputTokens: this.config.maxTokens },
    }
    if (systemPrompt) {
      body.systemInstruction = { parts: [{ text: systemPrompt }] }
    }
    const geminiTools = this.buildTools(tools)
    if (geminiTools.length > 0) {
      body.tools = geminiTools
    }
    return body
  }

  private buildContents(history: Event[]): GeminiContent[] {
    const contents: GeminiContent[] = []
    // tool_result events carry only `toolUseId`, but Gemini's functionResponse
    // is matched by function `name`. Resolve the name from the originating
    // tool_call event seen earlier in the same history.
    const toolNameById = new Map<string, string>()

    let currentRole: "user" | "model" | null = null
    let currentParts: GeminiPart[] = []

    const flush = () => {
      if (currentRole && currentParts.length > 0) {
        contents.push({ role: currentRole, parts: currentParts })
      }
      currentParts = []
    }

    const startTurn = (role: "user" | "model") => {
      if (currentRole !== role) {
        flush()
        currentRole = role
      }
    }

    for (const event of history) {
      if (event.type === "user") {
        startTurn("user")
        const text = String((event.data as { text?: unknown })?.text ?? event.data ?? "")
        if (text) currentParts.push({ text })
      } else if (event.type === "assistant") {
        startTurn("model")
        const text = String((event.data as { text?: unknown })?.text ?? event.data ?? "")
        if (text) currentParts.push({ text })
      } else if (event.type === "tool_call") {
        startTurn("model")
        const d = event.data as { name: string; params: unknown; toolUseId: string }
        toolNameById.set(d.toolUseId, d.name)
        currentParts.push({
          functionCall: {
            name: d.name,
            args: (d.params ?? {}) as Record<string, unknown>,
          },
        })
      } else if (event.type === "tool_result") {
        startTurn("user")
        const d = event.data as { toolUseId: string; result: unknown }
        const name = toolNameById.get(d.toolUseId) ?? "unknown"
        const wrapped =
          d.result !== null && typeof d.result === "object" && !Array.isArray(d.result)
            ? (d.result as Record<string, unknown>)
            : { result: d.result }
        currentParts.push({ functionResponse: { name, response: wrapped } })
      } else if (event.type === "summary") {
        startTurn("user")
        const text = String((event.data as { text?: unknown })?.text ?? "")
        currentParts.push({
          text: `[ARCHIVED CONTEXT]\n\n${text}\n\n[END ARCHIVED CONTEXT]`,
        })
      }
    }

    flush()
    return contents
  }

  private buildTools(tools: Tool[]): GeminiTool[] {
    if (tools.length === 0) return []
    return [
      {
        functionDeclarations: tools.map((tool) => {
          // $refStrategy:"none" inlines $ref/$defs — Gemini's schema doesn't
          // support refs. The sanitizer then drops everything Gemini doesn't
          // recognize (additionalProperties, $schema, oneOf, etc.) which
          // would otherwise return 400 "Invalid JSON payload: Unknown name".
          const raw = tool.inputSchema ?? zodToJsonSchema(tool.schema, { $refStrategy: "none" })
          return {
            name: tool.name,
            description: tool.description,
            parameters: sanitizeSchemaForGemini(raw) as Record<string, unknown>,
          }
        }),
      },
    ]
  }

  private buildResponse(data: GeminiResponseChunk): ModelResponse {
    const candidate = data.candidates?.[0]
    if (!candidate) throw new Error("google API returned no candidates")

    const textParts: string[] = []
    const toolCalls: Array<{ name: string; params: unknown }> = []

    for (const part of candidate.content?.parts ?? []) {
      if (part.text) textParts.push(part.text)
      if (part.functionCall) {
        toolCalls.push({
          name: part.functionCall.name,
          params: part.functionCall.args ?? {},
        })
      }
    }

    return {
      text: textParts.join(""),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: this.mapStopReason(candidate.finishReason, toolCalls.length > 0),
      usage: data.usageMetadata
        ? {
            inputTokens: data.usageMetadata.promptTokenCount ?? 0,
            outputTokens: data.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: data.usageMetadata.totalTokenCount ?? 0,
            credentialId: "google",
            model: this.config.model,
          }
        : undefined,
    }
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "x-goog-api-key": this.config.apiKey,
    }
  }

  // Gemini never returns "tool_use" as a finish reason — it returns STOP even
  // when the response contains functionCall parts. Infer tool_use from the
  // presence of toolCalls so the upstream loop knows to run them.
  private mapStopReason(reason: string | undefined, hasToolCalls: boolean): ModelResponse["stopReason"] {
    if (hasToolCalls) return "tool_use"
    switch (reason) {
      case "MAX_TOKENS":
        return "max_tokens"
      case "STOP":
      default:
        return "end_turn"
    }
  }
}
