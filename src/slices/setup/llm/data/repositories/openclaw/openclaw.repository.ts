import type { ILlmGateway } from "../../../domain/llm.gateway"
import type { ModelResponse } from "../../../domain/llm.types"
import type { Tool } from "../../../../../agent/tool/tool.module"
import type { Event } from "../../../../../agent/event"

/**
 * OpenClawRepository — proxies LLM calls through local OpenClaw gateway.
 * Uses the sessions API to run agent turns, which has access to the configured API key.
 */
export class OpenClawRepository implements ILlmGateway {
  private baseUrl: string
  private token: string
  private model: string

  constructor({ baseUrl = "http://localhost:18789", token, model = "anthropic/claude-sonnet-4-6" }: {
    baseUrl?: string
    token: string
    model?: string
  }) {
    this.baseUrl = baseUrl
    this.token = token
    this.model = model
  }

  async complete(systemPrompt: string, history: Event[], tools: Tool[]): Promise<ModelResponse> {
    const messages = this.eventsToMessages(history)
    const lastUserMessage = messages.filter(m => m.role === "user").pop()?.content ?? ""

    const res = await fetch(`${this.baseUrl}/api/agent/turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-openclaw-token": this.token,
      },
      body: JSON.stringify({
        model: this.model,
        system: systemPrompt,
        messages,
        tools: tools.map(t => ({ name: t.name, description: t.description })),
      }),
    })

    if (!res.ok) {
      throw new Error(`OpenClaw API error: ${res.status} ${await res.text()}`)
    }

    const data = await res.json() as { text?: string; toolCalls?: Array<{ name: string; params: unknown }> }
    return {
      text: data.text ?? "",
      toolCalls: data.toolCalls,
    }
  }

  private eventsToMessages(events: Event[]): Array<{ role: "user" | "assistant"; content: string }> {
    return events
      .filter(e => e.type === "user" || e.type === "assistant")
      .map(e => ({
        role: e.type as "user" | "assistant",
        content: String((e.data as { text?: unknown })?.text ?? e.data),
      }))
  }
}
