import { OpenAiCompatRepository } from "../openai-compat/openai-compat.repository"

/**
 * Mistral requires tool_call IDs to be exactly 9 alphanumeric characters.
 * Overrides remapToolCallId to convert UUIDs.
 */
export class MistralRepository extends OpenAiCompatRepository {
  constructor({ apiKey, model = "mistral-medium-latest", baseUrl = "https://api.mistral.ai", maxTokens = 8192 }: {
    apiKey: string
    model?: string
    baseUrl?: string
    maxTokens?: number
  }) {
    super({ apiKey, model, baseUrl, maxTokens, providerName: "mistral" })
  }

  protected remapToolCallId(id: string, idMap: Map<string, string>): string {
    const existing = idMap.get(id)
    if (existing) return existing
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    let short = ""
    for (let i = 0; i < 9; i++) short += chars[Math.floor(Math.random() * chars.length)]
    idMap.set(id, short)
    return short
  }
}
