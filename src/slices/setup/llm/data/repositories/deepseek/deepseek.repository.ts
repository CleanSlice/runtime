import { OpenAiCompatRepository } from "../openai-compat/openai-compat.repository"

export class DeepSeekRepository extends OpenAiCompatRepository {
  constructor({ apiKey, model = "deepseek-chat", baseUrl = "https://api.deepseek.com", maxTokens = 8192 }: {
    apiKey: string
    model?: string
    baseUrl?: string
    maxTokens?: number
  }) {
    super({ apiKey, model, baseUrl, maxTokens, providerName: "deepseek" })
  }
}
