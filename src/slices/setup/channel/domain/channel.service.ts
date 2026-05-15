import type { IChannelGateway } from "./channel.gateway"
import type { Message, MessagePart } from "./channel.types"

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

  /**
   * Start a single channel and add it to the service. Hooks the registered
   * message handler so messages flow through the same path as boot-time
   * channels. Used by the runtime-mutating channel tools.
   */
  async addAndStart(channel: IChannelGateway): Promise<void> {
    await channel.start()
    this.channels.push(channel)
    if (this.handler) channel.onMessage(this.handler)
  }

  /**
   * Stop and remove a channel by name. No-op when the channel isn't
   * registered. Returns true when something was removed.
   */
  async removeAndStop(name: string): Promise<boolean> {
    const idx = this.channels.findIndex(c => c.name === name)
    if (idx === -1) return false
    const ch = this.channels[idx]
    this.channels.splice(idx, 1)
    try {
      await ch.stop()
    } catch (err) {
      console.warn(`[channel] ${name} failed to stop cleanly:`, err)
    }
    return true
  }

  /** Names of currently registered channels — used by the channel_list tool. */
  listNames(): string[] {
    return this.channels.map(c => c.name)
  }

  async send(channel: string, to: string, text: string, parts?: MessagePart[]): Promise<void> {
    const ch = this.channels.find(c => c.name === channel)
    if (!ch) throw new Error(`Channel not found: ${channel}`)
    await ch.send(to, text, parts)
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
