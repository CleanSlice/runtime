import type { LlmConfig } from "./llm.module"

/**
 * Build an LlmConfig from a (provider, model, fallbackModel, apiKey) tuple.
 * Shared by the main runtime bootstrap (index.ts, main/aux LLM resolution)
 * and the RLM executor entrypoint (rlm-loop.service.ts, root/sub LLM
 * resolution) so provider defaulting stays consistent across both.
 */
export function buildLlmConfig(
  provider: string | undefined,
  model: string | undefined,
  fallbackModel: string | undefined,
  apiKey: string | undefined,
): LlmConfig {
  const p = provider ?? "claude"
  switch (p) {
    case "deepseek":
      return {
        provider: "deepseek",
        model: model ?? "deepseek-chat",
        fallbackModel,
        apiKey: apiKey ?? process.env.DEEPSEEK_API_KEY,
      }
    case "google":
      return {
        provider: "google",
        model: model ?? "gemini-2.0-flash",
        fallbackModel,
        apiKey: apiKey ?? process.env.GOOGLE_API_KEY,
      }
    case "mistral":
      return {
        provider: "mistral",
        model: model ?? "mistral-medium-latest",
        fallbackModel,
        apiKey: apiKey ?? process.env.MISTRAL_API_KEY,
      }
    case "openai":
      return {
        provider: "openai",
        model: model ?? "gpt-4o-mini",
        fallbackModel,
        apiKey: apiKey ?? process.env.OPENAI_API_KEY,
      }
    case "openrouter":
      return {
        provider: "openrouter",
        model: model ?? "anthropic/claude-sonnet-4",
        fallbackModel,
        apiKey: apiKey ?? process.env.OPENROUTER_API_KEY,
      }
    case "anthropic":
    case "claude":
    default:
      return {
        provider: "claude",
        model,
        fallbackModel,
        apiKey,
      }
  }
}
