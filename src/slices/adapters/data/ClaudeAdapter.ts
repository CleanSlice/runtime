import Anthropic from "@anthropic-ai/sdk"
import type { ModelAdapter, ModelResponse } from "../domain/ModelAdapter"
import type { Tool } from "../../../shared/types/Tool"
import type { Event } from "../../../shared/types/Event"
import { zodToJsonSchema } from "zod-to-json-schema"

export class ClaudeAdapter implements ModelAdapter {
  private client: Anthropic
  private model: string

  constructor({ model, apiKey }: { model: string; apiKey?: string }) {
    this.model = model
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY,
    })
  }

  async complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse> {
    const messages = this.eventsToMessages(history)

    const anthropicTools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: zodToJsonSchema(tool.schema) as Anthropic.Tool["input_schema"],
    }))

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
  }

  private eventsToMessages(events: Event[]): Anthropic.MessageParam[] {
    const messages: Anthropic.MessageParam[] = []

    for (const event of events) {
      if (event.type === "user") {
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
