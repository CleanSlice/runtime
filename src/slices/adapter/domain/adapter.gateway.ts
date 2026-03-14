import type { Tool } from "../../tool/tool.module"
import type { Event } from "../../event/event.module"
import type { ModelResponse } from "./adapter.types"

export interface AdapterGateway {
  complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse>
}
