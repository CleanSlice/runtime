import type { Tool } from "../../../agent/tool/tool.module"
import type { Event } from "../../event"
import type { ModelResponse } from "./llm.types"
import type { ILlmResourceStatus } from "./resource.types"

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

  /**
   * Optional — report current operating state: credential pool, rate-limit
   * cooldowns, context window. Only implemented by providers that maintain
   * non-trivial pool/rate state (currently Claude). LlmModule synthesizes
   * a minimal default when the underlying provider doesn't implement it.
   */
  getResourceSnapshot?(): ILlmResourceStatus
}
