import type { ILlmGateway } from "../domain/llm.gateway"
import { ClaudeRepository } from "./repositories/claude/claude.repository"

export type LlmGatewayConfig =
  | { provider: "claude"; apiKey?: string; model?: string }

export class LlmGateway implements ILlmGateway {
  private repository: ILlmGateway

  constructor(config: LlmGatewayConfig) {
    this.repository = this.createRepository(config)
  }

  private createRepository(config: LlmGatewayConfig): ILlmGateway {
    switch (config.provider) {
      case "claude":
        return new ClaudeRepository({
          apiKey: config.apiKey,
          model: config.model ?? "claude-sonnet-4-6",
        })
    }
  }

  complete(...args: Parameters<ILlmGateway["complete"]>) {
    return this.repository.complete(...args)
  }
}
