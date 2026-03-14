import type { IChannelGateway } from "../domain/channel.gateway"
import type { ChannelConfig } from "../domain/channel.types"
import type { Message } from "../domain/channel.types"
import { TelegramRepository } from "./repositories/telegram/telegram.repository"
import { SlackRepository } from "./repositories/slack/slack.repository"

export class ChannelGateway implements IChannelGateway {
  readonly name: string
  private repository: TelegramRepository | SlackRepository

  constructor(config: ChannelConfig) {
    this.name = config.type
    this.repository = this.createRepository(config)
  }

  private createRepository(config: ChannelConfig): TelegramRepository | SlackRepository {
    switch (config.type) {
      case "telegram":
        return new TelegramRepository(config.token)
      case "slack":
        return new SlackRepository(config.botToken, config.appToken)
    }
  }

  start(): Promise<void> {
    return this.repository.start()
  }

  stop(): Promise<void> {
    return this.repository.stop()
  }

  send(to: string, text: string): Promise<void> {
    return this.repository.send(to, text)
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.repository.onMessage(handler)
  }
}
