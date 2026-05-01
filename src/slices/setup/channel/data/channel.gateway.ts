import type { IChannelGateway } from "../domain/channel.gateway"
import type { ChannelConfig, Message, MessagePart } from "../domain/channel.types"
import { TelegramRepository } from "./repositories/telegram/telegram.repository"
import { SlackRepository } from "./repositories/slack/slack.repository"
import { BridleRepository, type BridleSyncHandler, type IBridleDebugPayload } from "./repositories/bridle/bridle.repository"

export class ChannelGateway implements IChannelGateway {
  readonly name: string
  private repository: TelegramRepository | SlackRepository | BridleRepository | IChannelGateway

  constructor(config: ChannelConfig) {
    this.name = config.type
    this.repository = this.createRepository(config)
  }

  private createRepository(config: ChannelConfig): TelegramRepository | SlackRepository | BridleRepository | IChannelGateway {
    switch (config.type) {
      case "telegram":
        return new TelegramRepository(config.token)
      case "slack":
        return new SlackRepository(config.botToken, config.appToken)
      case "bridle":
        return new BridleRepository(config.apiUrl)
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

  send(to: string, text: string, parts?: MessagePart[]): Promise<void> {
    return this.repository.send(to, text, parts)
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.repository.onMessage(handler)
  }

  streamSend(to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void> {
    if ('streamSend' in this.repository && typeof this.repository.streamSend === 'function') {
      return this.repository.streamSend(to, streamer)
    }
    return streamer(() => {}).then(text => this.repository.send(to, text))
  }

  /** Register a sync handler — only effective when this is a bridle channel. */
  onSync(handler: BridleSyncHandler): void {
    if (this.repository instanceof BridleRepository) {
      this.repository.onSync(handler)
    }
  }

  /** Emit a debug snapshot — only effective when this is a bridle channel. */
  sendDebug(to: string, payload: IBridleDebugPayload): void {
    if (this.repository instanceof BridleRepository) {
      this.repository.sendDebug(to, payload)
    }
  }

  /** Hub-pushed debug flag — false unless this is a bridle channel and hub set it. */
  isDebugEnabled(): boolean {
    return this.repository instanceof BridleRepository
      ? this.repository.isDebugEnabled()
      : false
  }
}
