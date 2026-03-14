import type { Tool } from "../../tool/tool.module"
import type { Event } from "../../event"
import type { ModelResponse } from "./llm.types"

export interface ILlmGateway {
  complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse>
}
