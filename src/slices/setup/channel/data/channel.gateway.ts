import type { IChannelGateway } from "../domain/channel.gateway"
import type { ChannelConfig, IChannelGroup, IThinkingStep, Message, MessagePart } from "../domain/channel.types"
import { isSilentReply } from "../../../agent/agent/domain/silentReply"
import type { SessionActivity } from "../../../agent/session/domain/activity"
import { TelegramRepository } from "./repositories/telegram/telegram.repository"
import { SlackRepository } from "./repositories/slack/slack.repository"
import { BridleRepository, type BridleSyncHandler, type IBridleDebugPayload } from "./repositories/bridle/bridle.repository"

export class ChannelGateway implements IChannelGateway {
  readonly name: string
  private repository: TelegramRepository | SlackRepository | BridleRepository | IChannelGateway
  // Defined only when the wrapped repository supports groups — channels
  // without the concept (bridle) stay undefined so consumers can skip them,
  // matching the optional domain contract.
  listGroups?: () => Promise<IChannelGroup[]>

  constructor(config: ChannelConfig, agentDir?: string) {
    this.name = config.type
    this.repository = this.createRepository(config, agentDir)
    const repo = this.repository
    if ('listGroups' in repo && typeof repo.listGroups === 'function') {
      this.listGroups = () => repo.listGroups!()
    }
  }

  private createRepository(config: ChannelConfig, agentDir?: string): TelegramRepository | SlackRepository | BridleRepository | IChannelGateway {
    switch (config.type) {
      case "telegram":
        // agentDir lets the repository persist its group registry
        return new TelegramRepository(config.token, agentDir)
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
    if (isSilentReply(text)) return Promise.resolve()
    return this.repository.send(to, text, parts)
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.repository.onMessage(handler)
  }

  streamSend(to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void> {
    if ('streamSend' in this.repository && typeof this.repository.streamSend === 'function') {
      return this.repository.streamSend(to, streamer)
    }
    return streamer(() => {}).then(text => {
      if (isSilentReply(text)) return
      return this.repository.send(to, text)
    })
  }

  /** Best-effort typing signal — only effective when the repository supports it. */
  sendTyping(to: string): Promise<void> {
    if (this.repository instanceof BridleRepository) {
      void this.repository.sendTyping(to)
    }
    return Promise.resolve()
  }

  /** Best-effort thinking-step publish — only effective on a bridle channel. */
  sendThinking(to: string, turnId: string, step?: IThinkingStep): Promise<void> {
    if (this.repository instanceof BridleRepository) {
      this.repository.sendThinking(to, turnId, step)
    }
    return Promise.resolve()
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

  /** Emit a live session-activity signal — only effective on a bridle channel. */
  reportActivity(activity: SessionActivity): void {
    if (this.repository instanceof BridleRepository) {
      this.repository.reportActivity(activity)
    }
  }

  /** Hub-pushed debug flag — false unless this is a bridle channel and hub set it. */
  isDebugEnabled(): boolean {
    return this.repository instanceof BridleRepository
      ? this.repository.isDebugEnabled()
      : false
  }
}
