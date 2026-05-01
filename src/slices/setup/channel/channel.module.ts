import type { Message, MessagePart } from "./domain/channel.types"
import { ChannelService } from "./domain/channel.service"
import { ChannelGateway } from "./data/channel.gateway"
import type { ChannelConfig } from "./domain/channel.types"
import type { BridleSyncHandler, IBridleDebugPayload } from "./data/repositories/bridle/bridle.repository"

export type { BridleSyncHandler, IBridleDebugPayload }

export class ChannelModule {
  private service: ChannelService

  constructor(configs: ChannelConfig[]) {
    this.service = new ChannelService()
    for (const cfg of configs) {
      this.service.add(new ChannelGateway(cfg))
    }
  }

  /**
   * Register a handler that runs when the bridle hub asks the agent to sync
   * its files to S3. No-op when the bridle channel isn't configured.
   */
  onBridleSync(handler: BridleSyncHandler): void {
    const bridle = this.service.get("bridle")
    if (bridle instanceof ChannelGateway) {
      bridle.onSync(handler)
    }
  }

  /**
   * Emit a debug snapshot to the bridle hub. No-op when bridle isn't
   * configured. The hub fans this out only to admin browser clients.
   */
  sendBridleDebug(to: string, payload: IBridleDebugPayload): void {
    const bridle = this.service.get("bridle")
    if (bridle instanceof ChannelGateway) {
      bridle.sendDebug(to, payload)
    }
  }

  /**
   * Whether the hub has pushed debug=true to this agent. Drives the loop's
   * emission gate alongside the BRIDLE_DEBUG env override.
   */
  isBridleDebugEnabled(): boolean {
    const bridle = this.service.get("bridle")
    return bridle instanceof ChannelGateway ? bridle.isDebugEnabled() : false
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

  async send(channel: string, to: string, text: string, parts?: MessagePart[]): Promise<void> {
    await this.service.send(channel, to, text, parts)
  }

  async streamSend(channel: string, to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void> {
    await this.service.streamSend(channel, to, streamer)
  }
}
