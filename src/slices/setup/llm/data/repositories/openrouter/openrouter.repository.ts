import { OpenAiCompatRepository } from "../openai-compat/openai-compat.repository"

export class OpenRouterRepository extends OpenAiCompatRepository {
  constructor({ apiKey, model = "anthropic/claude-sonnet-4", baseUrl = "https://openrouter.ai/api", maxTokens = 8192 }: {
    apiKey: string
    model?: string
    baseUrl?: string
    maxTokens?: number
  }) {
    super({
      apiKey,
      model,
      baseUrl,
      maxTokens,
      providerName: "openrouter",
      extraHeaders: {
        "HTTP-Referer": "https://cleanslice.dev",
      },
    })
  }
}
