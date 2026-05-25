import { LlmGateway } from "./data/llm.gateway"
import type { LlmConfig } from "./domain/llm.types"
import { LlmService } from "./domain/llm.service"
import type { ModelResponse } from "./domain/llm.types"
import type { ILlmResourceStatus } from "./domain/resource.types"
import type { Tool } from "../../agent/tool"
import type { Event } from "../event"

export { LlmConfig }

export class LlmModule {
  private service: LlmService
  private auxService?: LlmService
  private readonly config: LlmConfig
  private readonly auxConfig?: LlmConfig

  /**
   * @param config       Main LLM used for the agent's reasoning loop.
   * @param auxConfig    Optional auxiliary LLM used for background work
   *                     (compaction, summarization, future curator/insights).
   *                     When omitted, aux calls fall back to the main LLM.
   *                     Routing aux work to a cheaper/smaller model keeps
   *                     the main session's prompt cache hot and reduces cost.
   */
  constructor(config: LlmConfig, auxConfig?: LlmConfig) {
    this.config = config
    this.service = new LlmService(new LlmGateway(config))
    if (auxConfig) {
      this.auxConfig = auxConfig
      this.auxService = new LlmService(new LlmGateway(auxConfig))
    }
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

  /** Same shape as describe(), for the aux LLM. Returns main if no aux. */
  describeAux(): { provider: string; model: string } {
    const cfg = this.auxConfig ?? this.config
    return {
      provider: cfg.provider,
      model: ("model" in cfg && cfg.model) || "default",
    }
  }

  /** Whether a distinct auxiliary LLM is configured. */
  hasAux(): boolean {
    return this.auxService !== undefined
  }

  complete(systemPrompt: string, history: Event[], tools: Tool[]): Promise<ModelResponse> {
    return this.service.complete(systemPrompt, history, tools)
  }

  /**
   * Run a completion on the aux LLM. Falls back to the main LLM when no
   * aux is configured. Use for background tasks that should not contend
   * with the main session for cache / rate limits.
   */
  auxComplete(systemPrompt: string, history: Event[], tools: Tool[]): Promise<ModelResponse> {
    return (this.auxService ?? this.service).complete(systemPrompt, history, tools)
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

  /**
   * Aux gateway for callers that need the raw ILlmGateway interface
   * (e.g. CompactionService). Falls back to main gateway when no aux configured.
   */
  getAuxGateway(): import("./domain/llm.gateway").ILlmGateway {
    const svc = this.auxService ?? this.service
    return (svc as unknown as { gateway: import("./domain/llm.gateway").ILlmGateway }).gateway
  }

  /**
   * Operational snapshot for the agent's `resource_status` tool. Falls back
   * to a synthetic single-credential stub when the underlying provider
   * doesn't implement getResourceSnapshot (currently only Claude does).
   */
  getResourceSnapshot(): ILlmResourceStatus {
    const gw = this.getGateway()
    if (gw.getResourceSnapshot) return gw.getResourceSnapshot()
    const { provider, model } = this.describe()
    return {
      provider,
      model,
      contextWindow: 0,
      maxOutputTokens: 0,
      credentials: [{
        id: "default",
        active: true,
        cooldownUntilMs: 0,
        msUntilAvailable: 0,
        consecutive429s: 0,
      }],
      activeCredential: "default",
      anyAvailableNow: true,
      soonestAvailableMs: 0,
    }
  }
}
