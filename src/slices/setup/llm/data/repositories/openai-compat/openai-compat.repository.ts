import type { ILlmGateway } from "../../../domain/llm.gateway"
import type { ModelResponse } from "../../../domain/llm.types"
import type { Tool } from "../../../../../agent/tool/tool.module"
import type { Event } from "../../../../event"
import { zodToJsonSchema } from "zod-to-json-schema"

function stripThinking(text: string): string {
  return text.replace(/<thinking>[\s\S]*?<\/thinking>\s*/g, "").trim()
}

interface OaiMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface OaiTool {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface OpenAiCompatConfig {
  apiKey: string
  model: string
  baseUrl: string
  maxTokens: number
  /** Label used in usage.credentialId and error messages */
  providerName: string
  /** Extra headers sent with every request (e.g. HTTP-Referer for OpenRouter) */
  extraHeaders?: Record<string, string>
}

/**
 * Base repository for any OpenAI-compatible chat completions API.
 * Supports tool calling and SSE streaming.
 * Used by DeepSeek, Mistral, OpenRouter, and any compatible provider.
 */
export class OpenAiCompatRepository implements ILlmGateway {
  protected config: OpenAiCompatConfig

  constructor(config: OpenAiCompatConfig) {
    this.config = config
  }

  async complete(systemPrompt: string, history: Event[], tools: Tool[]): Promise<ModelResponse> {
    const messages = this.buildMessages(systemPrompt, history)
    const oaiTools = this.buildTools(tools)

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
    }
    if (oaiTools.length > 0) {
      body.tools = oaiTools
    }

    const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`${this.config.providerName} API error: ${res.status} ${text}`)
    }

    const data = await res.json() as {
      choices: Array<{
        message: {
          content: string | null
          tool_calls?: Array<{
            id: string
            function: { name: string; arguments: string }
          }>
        }
        finish_reason: string
      }>
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }

    const choice = data.choices[0]
    if (!choice) throw new Error(`${this.config.providerName} API returned no choices`)

    const toolCalls = choice.message.tool_calls?.map(tc => ({
      name: tc.function.name,
      params: JSON.parse(tc.function.arguments || "{}"),
    }))

    return {
      text: stripThinking(choice.message.content ?? ""),
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: data.usage ? {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
        credentialId: this.config.providerName,
      } : undefined,
    }
  }

  async stream(
    systemPrompt: string,
    history: Event[],
    tools: Tool[],
    onChunk: (text: string) => void,
  ): Promise<ModelResponse> {
    const messages = this.buildMessages(systemPrompt, history)
    const oaiTools = this.buildTools(tools)

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages,
      max_tokens: this.config.maxTokens,
      stream: true,
    }
    if (oaiTools.length > 0) {
      body.tools = oaiTools
    }

    const res = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`${this.config.providerName} API error: ${res.status} ${text}`)
    }

    let accumulated = ""
    const pendingTools = new Map<number, { id: string; name: string; args: string }>()
    let stopReason: string | undefined
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined

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
        if (payload === "[DONE]") continue

        const chunk = JSON.parse(payload) as {
          choices: Array<{
            delta: {
              content?: string
              tool_calls?: Array<{
                index: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            finish_reason?: string
          }>
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
        }

        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        if (delta.content) {
          accumulated += delta.content
          onChunk(stripThinking(accumulated))
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              pendingTools.set(tc.index, { id: tc.id, name: tc.function?.name ?? "", args: "" })
            }
            const pending = pendingTools.get(tc.index)
            if (pending && tc.function?.arguments) {
              pending.args += tc.function.arguments
            }
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          stopReason = chunk.choices[0].finish_reason
        }
        if (chunk.usage) {
          usage = chunk.usage
        }
      }
    }

    const toolCalls = [...pendingTools.values()].map(tc => ({
      name: tc.name,
      params: JSON.parse(tc.args || "{}"),
    }))

    return {
      text: stripThinking(accumulated),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: this.mapStopReason(stopReason ?? "stop"),
      usage: usage ? {
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
        credentialId: this.config.providerName,
      } : undefined,
    }
  }

  /** Override in subclasses to remap tool call IDs (e.g. Mistral's 9-char requirement) */
  protected remapToolCallId(id: string, _idMap: Map<string, string>): string {
    return id
  }

  protected buildMessages(systemPrompt: string, history: Event[]): OaiMessage[] {
    const messages: OaiMessage[] = [
      { role: "system", content: systemPrompt },
    ]

    const idMap = new Map<string, string>()

    for (const event of history) {
      if (event.type === "user") {
        messages.push({ role: "user", content: String((event.data as { text?: unknown })?.text ?? event.data) })
      } else if (event.type === "assistant") {
        messages.push({ role: "assistant", content: String((event.data as { text?: unknown })?.text ?? event.data) })
      } else if (event.type === "tool_call") {
        const d = event.data as { name: string; params: unknown; toolUseId: string }
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: this.remapToolCallId(d.toolUseId, idMap),
            type: "function",
            function: { name: d.name, arguments: JSON.stringify(d.params) },
          }],
        })
      } else if (event.type === "tool_result") {
        const d = event.data as { toolUseId: string; result: unknown }
        messages.push({
          role: "tool",
          content: JSON.stringify(d.result),
          tool_call_id: this.remapToolCallId(d.toolUseId, idMap),
        })
      } else if (event.type === "summary") {
        const text = String((event.data as { text?: unknown })?.text ?? "")
        messages.push({
          role: "user",
          content: `[ARCHIVED CONTEXT]\n\n${text}\n\n[END ARCHIVED CONTEXT]`,
        })
      }
    }

    return messages
  }

  private buildHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.config.apiKey}`,
      ...this.config.extraHeaders,
    }
  }

  private buildTools(tools: Tool[]): OaiTool[] {
    return tools.map(tool => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: zodToJsonSchema(tool.schema) as Record<string, unknown>,
      },
    }))
  }

  private mapStopReason(reason: string): ModelResponse["stopReason"] {
    switch (reason) {
      case "stop": return "end_turn"
      case "length": return "max_tokens"
      case "tool_calls": return "tool_use"
      default: return "end_turn"
    }
  }
}
