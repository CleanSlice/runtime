import type { Message } from "./domain/channel.types"
import { ChannelService } from "./domain/channel.service"
import { ChannelGateway, type ChannelConfig } from "./domain/channel.types"

export class ChannelModule {
  private service: ChannelService

  constructor(configs: ChannelConfig[]) {
    this.service = new ChannelService()
    for (const cfg of configs) {
      this.service.add(new ChannelGateway(cfg))
    }
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.service.onMessage(handler)
  }

  async start(): Promise<void> {
    await this.service.start()
  }

  async stop(): Promise<void> {
    await this.service.stop()
  }

  async send(channel: string, to: string, text: string): Promise<void> {
    await this.service.send(channel, to, text)
  }
}
