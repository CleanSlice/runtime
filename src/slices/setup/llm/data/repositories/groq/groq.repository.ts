import { OpenAiCompatRepository } from "../openai-compat/openai-compat.repository"

export class GroqRepository extends OpenAiCompatRepository {
  constructor({ apiKey, model = "llama-3.3-70b-versatile", baseUrl = "https://api.groq.com/openai", maxTokens = 8192 }: {
    apiKey: string
    model?: string
    baseUrl?: string
    maxTokens?: number
  }) {
    super({ apiKey, model, baseUrl, maxTokens, providerName: "groq" })
  }
}
