import type { ILlmGateway } from "../domain/llm.gateway"
import type { LlmConfig } from "../domain/llm.types"
import { ClaudeRepository } from "./repositories/claude/claude.repository"
import { ClaudeCliRepository } from "./repositories/claudecli/claudecli.repository"
import { DeepSeekRepository } from "./repositories/deepseek/deepseek.repository"
import { GoogleRepository } from "./repositories/google/google.repository"
import { MistralRepository } from "./repositories/mistral/mistral.repository"
import { OpenAiRepository } from "./repositories/openai/openai.repository"
import { OpenRouterRepository } from "./repositories/openrouter/openrouter.repository"

export class LlmGateway implements ILlmGateway {
  private repository: ILlmGateway

  constructor(config: LlmConfig) {
    this.repository = this.createRepository(config)
    // Expose stream() if the underlying repository supports it
    if (typeof (this.repository as ILlmGateway).stream === "function") {
      this.stream = (...args) => (this.repository as Required<ILlmGateway>).stream!(...args)
    }
    // Same passthrough for getResourceSnapshot (Claude implements it; others don't).
    if (typeof (this.repository as ILlmGateway).getResourceSnapshot === "function") {
      this.getResourceSnapshot = () => (this.repository as Required<ILlmGateway>).getResourceSnapshot!()
    }
  }

  private createRepository(config: LlmConfig): ILlmGateway {
    switch (config.provider) {
      case "claude":
        return new ClaudeRepository({
          apiKey: config.apiKey,
          model: config.model ?? process.env.LLM_MODEL ?? "claude-haiku-4-5",
          fallbackModel: config.fallbackModel ?? process.env.LLM_FALLBACK_MODEL ?? "claude-haiku-4-5",
          maxTokens: config.maxTokens,
          ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
        })
      case "claude-cli":
        return new ClaudeCliRepository({
          cliBin: config.cliBin ?? "/home/dmitriyzhuk/.local/bin/claude",
          model: config.model ?? "claude-sonnet-4-6",
        })
      case "deepseek":
        return new DeepSeekRepository({
          apiKey: config.apiKey ?? process.env.LLM_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? "",
          model: config.model ?? "deepseek-chat",
          baseUrl: config.baseUrl,
          maxTokens: config.maxTokens,
        })
      case "google":
        return new GoogleRepository({
          apiKey: config.apiKey ?? process.env.LLM_API_KEY ?? process.env.GOOGLE_API_KEY ?? "",
          model: config.model ?? "gemini-2.0-flash",
          baseUrl: config.baseUrl,
          maxTokens: config.maxTokens,
        })
      case "mistral":
        return new MistralRepository({
          apiKey: config.apiKey ?? process.env.LLM_API_KEY ?? process.env.MISTRAL_API_KEY ?? "",
          model: config.model ?? "mistral-medium-latest",
          baseUrl: config.baseUrl,
          maxTokens: config.maxTokens,
        })
      case "openai":
        return new OpenAiRepository({
          apiKey: config.apiKey ?? process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "",
          model: config.model ?? "gpt-4o-mini",
          baseUrl: config.baseUrl,
          maxTokens: config.maxTokens,
        })
      case "openrouter":
        return new OpenRouterRepository({
          apiKey: config.apiKey ?? process.env.LLM_API_KEY ?? process.env.OPENROUTER_API_KEY ?? "",
          model: config.model ?? "anthropic/claude-sonnet-4",
          baseUrl: config.baseUrl,
          maxTokens: config.maxTokens,
        })
    }
  }

  complete(...args: Parameters<ILlmGateway["complete"]>) {
    return this.repository.complete(...args)
  }

  stream?: ILlmGateway["stream"]
  getResourceSnapshot?: ILlmGateway["getResourceSnapshot"]
}
