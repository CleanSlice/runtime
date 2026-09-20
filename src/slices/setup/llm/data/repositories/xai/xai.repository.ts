import { OpenAiCompatRepository } from "../openai-compat/openai-compat.repository"

export class XaiRepository extends OpenAiCompatRepository {
  constructor({ apiKey, model = "grok-4", baseUrl = "https://api.x.ai", maxTokens = 8192 }: {
    apiKey: string
    model?: string
    baseUrl?: string
    maxTokens?: number
  }) {
    super({ apiKey, model, baseUrl, maxTokens, providerName: "xai" })
  }
}
