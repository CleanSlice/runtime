import { LlmGateway, type LlmGatewayConfig } from "./data/llm.gateway"
import { LlmService } from "./domain/llm.service"
import type { ModelResponse } from "./domain/llm.types"
import type { Tool } from "../tool"
import type { Event } from "../event"

export { LlmGatewayConfig }

export class LlmModule {
  private service: LlmService

  constructor(config: LlmGatewayConfig) {
    this.service = new LlmService(new LlmGateway(config))
  }

  complete(systemPrompt: string, history: Event[], tools: Tool[]): Promise<ModelResponse> {
    return this.service.complete(systemPrompt, history, tools)
  }
}
