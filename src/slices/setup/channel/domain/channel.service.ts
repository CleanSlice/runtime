import type { IChannelGateway } from "./channel.gateway"
import type { IChannelGroup, Message, MessagePart } from "./channel.types"
import { isSilentReply } from "../../../agent/agent/domain/silentReply"
import { createLogger } from "../../logger"

const log = createLogger("channel")

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
        log.error(`${this.channels[i].name} failed to start`, (results[i] as PromiseRejectedResult).reason)
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
      log.warn(`${name} failed to stop cleanly`, err)
    }
    return true
  }

  /** Names of currently registered channels — used by the channel_list tool. */
  listNames(): string[] {
    return this.channels.map(c => c.name)
  }

  /**
   * Groups/rooms per channel — used by the channel_groups tool. Channels
   * without the concept are skipped; a channel whose lookup fails is
   * reported with an error instead of hiding the whole result.
   */
  async listGroups(channel?: string): Promise<Array<{ channel: string; groups: IChannelGroup[]; error?: string }>> {
    const targets = channel
      ? this.channels.filter(c => c.name === channel)
      : this.channels
    const out: Array<{ channel: string; groups: IChannelGroup[]; error?: string }> = []
    for (const ch of targets) {
      if (!ch.listGroups) continue
      try {
        out.push({ channel: ch.name, groups: await ch.listGroups() })
      } catch (err) {
        log.warn(`${ch.name} listGroups failed`, err)
        out.push({ channel: ch.name, groups: [], error: (err as Error).message })
      }
    }
    return out
  }

  async send(channel: string, to: string, text: string, parts?: MessagePart[]): Promise<void> {
    if (isSilentReply(text)) {
      log.warn(`dropping NO_REPLY sentinel on ${channel}`)
      return
    }
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
      if (isSilentReply(text)) return
      await ch.send(to, text)
    }
  }

  /** Get a channel gateway by name */
  get(name: string): IChannelGateway | undefined {
    return this.channels.find(c => c.name === name)
  }
}
