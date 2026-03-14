import type { Tool } from "../../tool/tool.module"
import type { Event } from "../../event/event.module"

export interface ModelResponse {
  text: string
  toolCalls?: Array<{ name: string; params: unknown }>
}

export interface ModelAdapter {
  complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse>
}
