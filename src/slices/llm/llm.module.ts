import { LlmGateway } from "./data/llm.gateway"
import type { LlmConfig } from "./domain/llm.types"
import { LlmService } from "./domain/llm.service"
import type { ModelResponse } from "./domain/llm.types"
import type { Tool } from "../tool"
import type { Event } from "../event"

export { LlmConfig }

export class LlmModule {
  private service: LlmService

  constructor(config: LlmConfig) {
    this.service = new LlmService(new LlmGateway(config))
  }

  complete(systemPrompt: string, history: Event[], tools: Tool[]): Promise<ModelResponse> {
    return this.service.complete(systemPrompt, history, tools)
  }

  // Expose gateway for compaction (needs ILlmGateway interface)
  getGateway(): import("./domain/llm.gateway").ILlmGateway {
    return (this.service as unknown as { gateway: import("./domain/llm.gateway").ILlmGateway }).gateway
  }
}
