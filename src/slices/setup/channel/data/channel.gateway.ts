import type { IChannelGateway } from "../domain/channel.gateway"
import type { ChannelConfig } from "../domain/channel.types"
import type { Message } from "../domain/channel.types"
import { TelegramRepository } from "./repositories/telegram/telegram.repository"
import { SlackRepository } from "./repositories/slack/slack.repository"
import { WebRepository } from "./repositories/web/web.repository"

export class ChannelGateway implements IChannelGateway {
  readonly name: string
  private repository: TelegramRepository | SlackRepository | WebRepository | IChannelGateway

  constructor(config: ChannelConfig) {
    this.name = config.type
    this.repository = this.createRepository(config)
  }

  private createRepository(config: ChannelConfig): TelegramRepository | SlackRepository | WebRepository | IChannelGateway {
    switch (config.type) {
      case "telegram":
        return new TelegramRepository(config.token)
      case "slack":
        return new SlackRepository(config.botToken, config.appToken)
      case "web":
        return new WebRepository(config.apiUrl)
      case "mock":
        return config.instance
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

  streamSend(to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void> {
    if ((this.repository instanceof TelegramRepository || this.repository instanceof WebRepository) && this.repository.streamSend) {
      return this.repository.streamSend(to, streamer)
    }
    // Fallback for non-streaming channels
    return streamer(() => {}).then(text => this.repository.send(to, text))
  }
}
