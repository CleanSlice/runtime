import type { ILlmGateway } from "./llm.gateway"
import type { Tool } from "../../../agent/tool/tool.module"
import type { Event } from "../../event"
import type { ModelResponse } from "./llm.types"

export class LlmService {
  constructor(private gateway: ILlmGateway) {}

  async complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse> {
    return this.gateway.complete(systemPrompt, history, tools)
  }
}
