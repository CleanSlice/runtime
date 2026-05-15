import type { Message, MessagePart } from "./domain/channel.types"
import { ChannelService } from "./domain/channel.service"
import { ChannelGateway } from "./data/channel.gateway"
import type { ChannelConfig } from "./domain/channel.types"
import type { BridleSyncHandler, IBridleDebugPayload } from "./data/repositories/bridle/bridle.repository"
import {
  type ChannelFileType,
  type IChannelsFile,
  type ITelegramFileEntry,
  type ISlackFileEntry,
  loadChannelsFile,
  saveChannelsFile,
} from "./data/channelsFile"

export type { BridleSyncHandler, IBridleDebugPayload }
export type { ChannelFileType, ITelegramFileEntry, ISlackFileEntry }

// What the channel_list tool returns. Tokens are masked.
export interface IChannelInfo {
  type: string
  source: "file" | "env"
  connected: boolean
  config: Record<string, string>
}

export class ChannelModule {
  private service: ChannelService
  // When set, runtime mutations (addChannel/removeChannel) persist to
  // <agentDir>/data/channels.json. Without it, the module is in legacy/mock
  // mode and write methods throw.
  private agentDir?: string

  constructor(configs: ChannelConfig[], agentDir?: string) {
    this.service = new ChannelService()
    this.agentDir = agentDir
    for (const cfg of configs) {
      this.service.add(new ChannelGateway(cfg))
    }
  }

  /**
   * Resolve channel configs to use at boot — file overrides env per channel
   * type. Bridle is always env-based (it's the bootstrap channel the runtime
   * can't reconfigure itself). Standalone usage with only env still works:
   * if channels.json is missing, env wins.
   */
  static async resolveBootConfigs(agentDir: string): Promise<ChannelConfig[]> {
    const file = await loadChannelsFile(agentDir)
    const configs: ChannelConfig[] = []

    if (file.telegram?.botToken) {
      configs.push({ type: "telegram", token: file.telegram.botToken })
      applyTelegramToEnv(file.telegram)
    } else if (process.env.TELEGRAM_BOT_TOKEN) {
      configs.push({ type: "telegram", token: process.env.TELEGRAM_BOT_TOKEN })
    }

    if (file.slack?.botToken && file.slack.appToken) {
      configs.push({
        type: "slack",
        botToken: file.slack.botToken,
        appToken: file.slack.appToken,
      })
      process.env.SLACK_BOT_TOKEN = file.slack.botToken
      process.env.SLACK_APP_TOKEN = file.slack.appToken
    } else if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
      configs.push({
        type: "slack",
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: process.env.SLACK_APP_TOKEN,
      })
    }

    if (process.env.BRIDLE_URL) {
      configs.push({ type: "bridle", apiUrl: process.env.BRIDLE_URL })
    }

    return configs
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

  // ── Runtime channel mutation ────────────────────────────────────────────
  // Tools call these to let the agent configure its own channels mid-session.
  // Persist-first, connect-second so a successful tool call survives restart;
  // a failed connect rolls the file back to its previous state.

  async setTelegram(entry: ITelegramFileEntry): Promise<void> {
    this.requireAgentDir("setTelegram")
    const prev = await loadChannelsFile(this.agentDir!)
    const next: IChannelsFile = { ...prev, telegram: entry }
    await saveChannelsFile(this.agentDir!, next)
    try {
      await this.service.removeAndStop("telegram")
      const gateway = new ChannelGateway({
        type: "telegram",
        token: entry.botToken,
      })
      await this.service.addAndStart(gateway)
      applyTelegramToEnv(entry)
    } catch (err) {
      // Roll the file back so list() doesn't lie about state.
      await saveChannelsFile(this.agentDir!, prev)
      throw err
    }
  }

  async setSlack(entry: ISlackFileEntry): Promise<void> {
    this.requireAgentDir("setSlack")
    const prev = await loadChannelsFile(this.agentDir!)
    const next: IChannelsFile = { ...prev, slack: entry }
    await saveChannelsFile(this.agentDir!, next)
    try {
      await this.service.removeAndStop("slack")
      const gateway = new ChannelGateway({
        type: "slack",
        botToken: entry.botToken,
        appToken: entry.appToken,
      })
      await this.service.addAndStart(gateway)
      process.env.SLACK_BOT_TOKEN = entry.botToken
      process.env.SLACK_APP_TOKEN = entry.appToken
    } catch (err) {
      await saveChannelsFile(this.agentDir!, prev)
      throw err
    }
  }

  async removeChannel(type: ChannelFileType): Promise<boolean> {
    this.requireAgentDir("removeChannel")
    const prev = await loadChannelsFile(this.agentDir!)
    if (!prev[type]) {
      // Nothing in the file, but a live channel may still exist (env-sourced).
      return this.service.removeAndStop(type)
    }
    const next: IChannelsFile = { ...prev }
    delete next[type]
    await saveChannelsFile(this.agentDir!, next)
    return this.service.removeAndStop(type)
  }

  /**
   * Snapshot of currently configured channels for the channel_list tool and
   * the admin UI. Sources merge file + env so listing reflects what's
   * actually running.
   */
  async listInfo(): Promise<IChannelInfo[]> {
    const file = this.agentDir ? await loadChannelsFile(this.agentDir) : {}
    const liveNames = new Set(this.service.listNames())
    const out: IChannelInfo[] = []

    if (file.telegram?.botToken) {
      out.push({
        type: "telegram",
        source: "file",
        connected: liveNames.has("telegram"),
        config: maskTelegram(file.telegram),
      })
    } else if (process.env.TELEGRAM_BOT_TOKEN) {
      out.push({
        type: "telegram",
        source: "env",
        connected: liveNames.has("telegram"),
        config: maskTelegram({
          botToken: process.env.TELEGRAM_BOT_TOKEN,
          botName: process.env.TELEGRAM_BOT_NAME,
          adminIds: process.env.TELEGRAM_BOT_ADMIN_IDS,
        }),
      })
    }

    if (file.slack?.botToken && file.slack.appToken) {
      out.push({
        type: "slack",
        source: "file",
        connected: liveNames.has("slack"),
        config: maskSlack(file.slack),
      })
    } else if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN) {
      out.push({
        type: "slack",
        source: "env",
        connected: liveNames.has("slack"),
        config: maskSlack({
          botToken: process.env.SLACK_BOT_TOKEN,
          appToken: process.env.SLACK_APP_TOKEN,
        }),
      })
    }

    if (process.env.BRIDLE_URL) {
      out.push({
        type: "bridle",
        source: "env",
        connected: liveNames.has("bridle"),
        config: { apiUrl: process.env.BRIDLE_URL },
      })
    }

    return out
  }

  private requireAgentDir(op: string): void {
    if (!this.agentDir) {
      throw new Error(
        `[channels] ${op} requires agentDir — module was constructed without it (legacy/mock mode)`,
      )
    }
  }
}

function applyTelegramToEnv(entry: ITelegramFileEntry): void {
  // The runtime's access list and a couple of other consumers still read
  // these via process.env at construction time. Keep them in sync so a freshly
  // configured channel doesn't need a full restart to land in env-based reads.
  process.env.TELEGRAM_BOT_TOKEN = entry.botToken
  if (entry.botName !== undefined) {
    process.env.TELEGRAM_BOT_NAME = entry.botName
  }
  if (entry.adminIds !== undefined) {
    process.env.TELEGRAM_BOT_ADMIN_IDS = entry.adminIds
  }
}

function mask(v: string | undefined): string {
  if (!v) return ""
  if (v.length <= 8) return "•".repeat(v.length)
  return `${v.slice(0, 4)}${"•".repeat(Math.max(8, v.length - 8))}${v.slice(-4)}`
}

function maskTelegram(entry: ITelegramFileEntry): Record<string, string> {
  const out: Record<string, string> = { botToken: mask(entry.botToken) }
  if (entry.botName) out.botName = entry.botName
  if (entry.adminIds) out.adminIds = entry.adminIds
  return out
}

function maskSlack(entry: ISlackFileEntry): Record<string, string> {
  return { botToken: mask(entry.botToken), appToken: mask(entry.appToken) }
}
