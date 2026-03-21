import type { Tool } from "../../../agent/tool/tool.module"
import type { Event } from "../../../agent/event"
import type { ModelResponse } from "./llm.types"

export interface ILlmGateway {
  complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse>

  /**
   * Stream text tokens as they arrive. Calls onChunk with accumulated text.
   * Returns full ModelResponse when done.
   * Falls back to complete() if streaming not supported.
   */
  stream?(
    systemPrompt: string,
    history: Event[],
    tools: Tool[],
    onChunk: (text: string) => void
  ): Promise<ModelResponse>
}
