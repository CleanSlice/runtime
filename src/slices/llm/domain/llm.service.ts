import type { LlmGateway } from "./llm.gateway"
import type { Tool } from "../../tool/tool.module"
import type { Event } from "../../event/event.module"
import type { ModelResponse } from "./llm.types"

export class LlmService {
  constructor(private gateway: LlmGateway) {}

  async complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse> {
    return this.gateway.complete(systemPrompt, history, tools)
  }
}
