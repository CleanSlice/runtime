import type { IChannelGateway } from "../domain/channel.gateway"
import type { Message } from "../domain/channel.types"
import { ChannelGateway } from "./data/channel.gateway"

export interface ChannelGatewayConfig {
  type: "telegram"
  token: string
}

export class ChannelGateway implements IChannelGateway {
  readonly name: string
  private repository: ChannelGateway

  constructor(config: ChannelGatewayConfig) {
    this.name = config.type
    this.repository = this.createRepository(config)
  }

  private createRepository(config: ChannelGatewayConfig): ChannelGateway {
    switch (config.type) {
      case "telegram":
        return new ChannelGateway(config.token)
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
