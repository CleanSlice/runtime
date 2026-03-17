import type { ILlmGateway } from "../domain/llm.gateway"
import type { LlmConfig } from "../domain/llm.types"
import { ClaudeRepository } from "./repositories/claude/claude.repository"
import { ClaudeCliRepository } from "./repositories/claudecli/claudecli.repository"

export class LlmGateway implements ILlmGateway {
  private repository: ILlmGateway

  constructor(config: LlmConfig) {
    this.repository = this.createRepository(config)
    // Expose stream() if the underlying repository supports it
    if (typeof (this.repository as ILlmGateway).stream === "function") {
      this.stream = (...args) => (this.repository as Required<ILlmGateway>).stream!(...args)
    }
  }

  private createRepository(config: LlmConfig): ILlmGateway {
    switch (config.provider) {
      case "claude":
        return new ClaudeRepository({
          apiKey: config.apiKey,
          model: config.model ?? process.env.LLM_MODEL ?? "claude-haiku-4-5",
          fallbackModel: config.fallbackModel ?? process.env.LLM_FALLBACK_MODEL ?? "claude-haiku-4-5",
          ...(config.proxyUrl ? { proxyUrl: config.proxyUrl } : {}),
        })
      case "claude-cli":
        return new ClaudeCliRepository({
          cliBin: config.cliBin ?? "/home/dmitriyzhuk/.local/bin/claude",
          model: config.model ?? "claude-sonnet-4-6",
        })
    }
  }

  complete(...args: Parameters<ILlmGateway["complete"]>) {
    return this.repository.complete(...args)
  }

  stream?: ILlmGateway["stream"]
}
