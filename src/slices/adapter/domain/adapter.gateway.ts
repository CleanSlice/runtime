import type { Tool } from "../../../shared/types/Tool"
import type { Event } from "../../../shared/types/Event"
import type { ModelResponse } from "./adapter.types"

export interface AdapterGateway {
  complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse>
}
