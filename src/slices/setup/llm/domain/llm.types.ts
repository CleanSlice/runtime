import type { Tool } from "../../../agent/tool/tool.module"
import type { Event } from "../../../agent/event"

export interface ModelResponse {
  text: string
  toolCalls?: Array<{ name: string; params: unknown }>
}

export interface ModelLlm {
  complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse>
}

export type LlmConfig =
  | { provider: "claude"; apiKey?: string; model?: string; fallbackModel?: string; proxyUrl?: string }
  | { provider: "claude-cli"; cliBin?: string; model?: string }
