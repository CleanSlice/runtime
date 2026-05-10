import { OpenAiCompatRepository } from "../openai-compat/openai-compat.repository"

/**
 * Native OpenAI provider. OpenAI's API is the canonical Chat Completions
 * format, so the shared OpenAi-compat base handles it 1:1 — no overrides
 * needed. Tool call IDs (`call_<rand>`) are already long enough that the
 * default identity remap works.
 */
export class OpenAiRepository extends OpenAiCompatRepository {
  constructor({ apiKey, model = "gpt-4o-mini", baseUrl = "https://api.openai.com", maxTokens = 8192 }: {
    apiKey: string
    model?: string
    baseUrl?: string
    maxTokens?: number
  }) {
    super({ apiKey, model, baseUrl, maxTokens, providerName: "openai" })
  }
}
