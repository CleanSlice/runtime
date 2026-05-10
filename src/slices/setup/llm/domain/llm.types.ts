import type { Tool } from "../../../agent/tool/tool.module"
import type { Event } from "../../event"

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  credentialId?: string  // e.g. "oauth-0", "oauth-1", "apikey"
  /**
   * Canonical model name that produced this response (e.g. "claude-sonnet-4-6").
   * Set by the repository — UsageService aggregates by this so the upstream
   * (e.g. ranch) can show per-model spend, not just per-credential.
   */
  model?: string
}

export interface ModelResponse {
  text: string
  toolCalls?: Array<{ name: string; params: unknown }>
  usage?: ModelUsage
  stopReason?: "end_turn" | "max_tokens" | "tool_use" | "stop_sequence"
}

export interface ModelLlm {
  complete(
    systemPrompt: string,
    history: Event[],
    tools: Tool[]
  ): Promise<ModelResponse>
}

export type LlmConfig =
  | { provider: "claude"; apiKey?: string; model?: string; fallbackModel?: string; proxyUrl?: string; maxTokens?: number }
  | { provider: "claude-cli"; cliBin?: string; model?: string }
  | { provider: "deepseek"; apiKey?: string; model?: string; fallbackModel?: string; baseUrl?: string; maxTokens?: number }
  | { provider: "mistral"; apiKey?: string; model?: string; fallbackModel?: string; baseUrl?: string; maxTokens?: number }
  | { provider: "openrouter"; apiKey?: string; model?: string; fallbackModel?: string; baseUrl?: string; maxTokens?: number }
