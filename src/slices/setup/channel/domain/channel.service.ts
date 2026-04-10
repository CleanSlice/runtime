import type { IChannelGateway } from "./channel.gateway"
import type { Message } from "./channel.types"

export class ChannelService {
  private channels: IChannelGateway[] = []
  private handler?: (msg: Message) => Promise<void>

  add(channel: IChannelGateway): void {
    this.channels.push(channel)
    if (this.handler) channel.onMessage(this.handler)
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.handler = handler
    for (const ch of this.channels) {
      ch.onMessage(handler)
    }
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled(this.channels.map(ch => ch.start()))
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.error(`[channel] ${this.channels[i].name} failed to start:`, (results[i] as PromiseRejectedResult).reason)
      }
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.channels.map(ch => ch.stop()))
  }

  async send(channel: string, to: string, text: string): Promise<void> {
    const ch = this.channels.find(c => c.name === channel)
    if (!ch) throw new Error(`Channel not found: ${channel}`)
    await ch.send(to, text)
  }

  async streamSend(channel: string, to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void> {
    const ch = this.channels.find(c => c.name === channel)
    if (!ch) throw new Error(`Channel not found: ${channel}`)
    if (ch.streamSend) {
      await ch.streamSend(to, streamer)
    } else {
      const text = await streamer(() => {})
      await ch.send(to, text)
    }
  }

  /** Get a channel gateway by name */
  get(name: string): IChannelGateway | undefined {
    return this.channels.find(c => c.name === name)
  }
}
