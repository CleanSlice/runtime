import type { Tool } from "../../tool/tool.module"
import type { Event } from "../../event"

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
  | { provider: "claude"; apiKey?: string; model?: string }
  | { provider: "claude-cli"; cliBin?: string; model?: string; oauthToken?: string }
