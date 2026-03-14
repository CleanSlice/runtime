import type { ILlmGateway } from "../domain/llm.gateway"
import type { LlmConfig } from "../domain/llm.types"
import { ClaudeRepository } from "./repositories/claude/claude.repository"
import { ClaudeCliRepository } from "./repositories/claudecli/claudecli.repository"

export class LlmGateway implements ILlmGateway {
  private repository: ILlmGateway

  constructor(config: LlmConfig) {
    this.repository = this.createRepository(config)
  }

  private createRepository(config: LlmConfig): ILlmGateway {
    switch (config.provider) {
      case "claude":
        return new ClaudeRepository({
          apiKey: config.apiKey,
          model: config.model ?? "claude-sonnet-4-6",
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
}
