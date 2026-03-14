import type { Tool } from "../../../shared/types/Tool"
import type { Event } from "../../../shared/types/Event"

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
