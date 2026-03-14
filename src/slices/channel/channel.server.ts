import type { ChannelGateway } from "./domain/channel.gateway"
import type { Message } from "../../shared/types/Message"

export class ChannelServer {
  private channels: ChannelGateway[] = []
  private handler?: (msg: Message) => Promise<void>

  add(channel: ChannelGateway): void {
    this.channels.push(channel)
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.handler = handler
    for (const ch of this.channels) {
      ch.onMessage(handler)
    }
  }

  async start(): Promise<void> {
    await Promise.all(this.channels.map(ch => ch.start()))
  }

  async stop(): Promise<void> {
    await Promise.all(this.channels.map(ch => ch.stop()))
  }

  async send(channel: string, to: string, text: string): Promise<void> {
    const ch = this.channels.find(c => c.name === channel)
    if (!ch) throw new Error(`Channel not found: ${channel}`)
    await ch.send(to, text)
  }
}
