import { LlmGateway } from "./data/llm.gateway"
import type { LlmConfig } from "./domain/llm.types"
import { LlmService } from "./domain/llm.service"
import type { ModelResponse } from "./domain/llm.types"
import type { Tool } from "../../agent/tool"
import type { Event } from "../event"

export { LlmConfig }

export class LlmModule {
  private service: LlmService
  private readonly config: LlmConfig

  constructor(config: LlmConfig) {
    this.config = config
    this.service = new LlmService(new LlmGateway(config))
  }

  /**
   * Provider + model identifiers used to dispatch the current LLM. Useful
   * for telemetry / debug panels — not for routing logic.
   */
  describe(): { provider: string; model: string } {
    return {
      provider: this.config.provider,
      model: ("model" in this.config && this.config.model) || "default",
    }
  }

  complete(systemPrompt: string, history: Event[], tools: Tool[]): Promise<ModelResponse> {
    return this.service.complete(systemPrompt, history, tools)
  }

  canStream(): boolean {
    const gw = this.getGateway()
    return typeof gw.stream === "function"
  }

  stream(systemPrompt: string, history: Event[], tools: Tool[], onChunk: (text: string) => void): Promise<ModelResponse> {
    const gw = this.getGateway()
    if (gw.stream) {
      return gw.stream(systemPrompt, history, tools, onChunk)
    }
    return this.service.complete(systemPrompt, history, tools)
  }

  // Expose gateway for compaction (needs ILlmGateway interface)
  getGateway(): import("./domain/llm.gateway").ILlmGateway {
    return (this.service as unknown as { gateway: import("./domain/llm.gateway").ILlmGateway }).gateway
  }
}
