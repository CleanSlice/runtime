import type { AdapterGateway } from "./adapter.gateway"
import type { Tool } from "../../tool/tool.module"
import type { Event } from "../../event/event.module"
import type { ModelResponse } from "./adapter.types"

export class AdapterService {
  constructor(private gateway: AdapterGateway) {}

  async complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse> {
    return this.gateway.complete(systemPrompt, history, tools)
  }
}
