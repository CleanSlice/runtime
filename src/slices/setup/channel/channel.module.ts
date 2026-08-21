import type { IChannelGroup, IThinkingStep, Message, MessagePart } from "./domain/channel.types"
import { ChannelService } from "./domain/channel.service"
import { ChannelGateway } from "./data/channel.gateway"
import type { ChannelConfig } from "./domain/channel.types"
import type { BridleSyncHandler, BridleSessionClearHandler, IBridleDebugPayload } from "./data/repositories/bridle/bridle.repository"
import type { SessionActivity } from "../../agent/session/domain/activity"
import { existsSync } from "fs"
import {
  migrateLegacyChannelFiles,
  updateChannelStatus,
  type ChannelFileType,
} from "./data/channelFiles"
import {
  type ITelegramFile,
  loadTelegramFile,
  saveTelegramFile,
  telegramFilePath,
  updateTelegramFile,
} from "./data/repositories/telegram/telegramFile"
import {
  type ISlackFile,
  loadSlackFile,
  saveSlackFile,
  slackFilePath,
} from "./data/repositories/slack/slackFile"
import { createLogger } from "../logger"

const log = createLogger("channels")

export type { BridleSyncHandler, BridleSessionClearHandler, IBridleDebugPayload }
export type { ChannelFileType }

// Config entries as the channel_* tools pass them in — the persisted files
// (ITelegramFile / ISlackFile) may hold more (e.g. telegram's group registry).
export interface ITelegramFileEntry {
  botToken: string
  botName?: string
  adminIds?: string
}

export interface ISlackFileEntry {
  botToken: string
  appToken: string
}

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
  // <agentDir>/data/channels/<type>.json. Without it, the module is in
  // legacy/mock mode and write methods throw.
  private agentDir?: string
  // Credential fingerprint per channel type — lets reconcileFromDisk tell
  // "same config, leave it alone" from "token changed, replace the gateway"
  // without the gateways having to expose their secrets.
  private activeKeys = new Map<string, string>()
  // Mock channels mean a test/paddock harness — reconcile must never mix
  // real file/env channels into those runs.
  private hasMock = false

  constructor(configs: ChannelConfig[], agentDir?: string) {
    this.service = new ChannelService()
    this.agentDir = agentDir
    for (const cfg of configs) {
      this.service.add(new ChannelGateway(cfg, agentDir))
      if (cfg.type === "mock") this.hasMock = true
      const key = configKey(cfg)
      if (key) this.activeKeys.set(cfg.type, key)
    }
  }

  /**
   * Resolve channel configs to use at boot — file overrides env per channel
   * type. Bridle is always env-based (it's the bootstrap channel the runtime
   * can't reconfigure itself). Standalone usage with only env still works:
   * if data/channels/<type>.json is missing, env wins. Legacy flat files
   * (channels.json, telegram-groups.json) migrate to the new layout here.
   */
  static async resolveBootConfigs(agentDir: string): Promise<ChannelConfig[]> {
    await migrateLegacyChannelFiles(agentDir)
    const telegram = await loadTelegramFile(agentDir)
    const slack = await loadSlackFile(agentDir)
    const configs: ChannelConfig[] = []

    // A tombstone (`removed: true`) blocks the env fallback: the pod env
    // keeps the old token until the next redeploy, and without the tombstone
    // a restart would resurrect an explicitly removed channel. A file with
    // no token but no tombstone (e.g. groups-only, bot configured via env)
    // still falls through to env.
    if (telegram.botToken && !telegram.removed) {
      configs.push({ type: "telegram", token: telegram.botToken })
      applyTelegramToEnv(telegram)
    } else if (!telegram.removed && process.env.TELEGRAM_BOT_TOKEN) {
      configs.push({ type: "telegram", token: process.env.TELEGRAM_BOT_TOKEN })
    }

    if (slack.removed) {
      // explicitly removed — skip both file and env
    } else if (slack.botToken && slack.appToken) {
      configs.push({
        type: "slack",
        botToken: slack.botToken,
        appToken: slack.appToken,
      })
      process.env.SLACK_BOT_TOKEN = slack.botToken
      process.env.SLACK_APP_TOKEN = slack.appToken
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
   * Re-resolve file/env channel configs and reconcile the registered set —
   * called after the S3 pull lands persisted state (restoreState), BEFORE
   * channels start. At construction time a fresh container filesystem has no
   * data/channels/* yet, so a chat-configured bot resolved to nothing and
   * stayed dead after every restart; this closes that race. Only registers
   * gateways — the subsequent ChannelService.start() starts everything once.
   */
  async reconcileFromDisk(): Promise<void> {
    if (!this.agentDir || this.hasMock) return
    const resolved = await ChannelModule.resolveBootConfigs(this.agentDir)
    for (const type of ["telegram", "slack"] as const) {
      const live = new Set(this.service.listNames())
      const cfg = resolved.find(c => c.type === type)
      if (!cfg) {
        // Tombstoned or config gone from every source — nothing may run.
        if (live.has(type)) {
          await this.service.removeAndStop(type)
          this.activeKeys.delete(type)
          await this.writeStatusGone(type)
          log.info(`${type} deregistered after state pull (removed or unconfigured)`)
        }
        continue
      }
      const key = configKey(cfg)!
      if (live.has(type)) {
        if (this.activeKeys.get(type) === key) continue
        await this.service.removeAndStop(type)
        log.info(`${type} credentials changed on disk — replacing gateway`)
      } else {
        log.info(`${type} config landed with pulled state — registering`)
      }
      this.service.add(new ChannelGateway(cfg, this.agentDir))
      this.activeKeys.set(type, key)
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
   * Register a handler that runs when the bridle hub asks the agent to drop
   * its local copy of a session (sent after the hub archives/deletes that
   * channel's persisted transcript). No-op when the bridle channel isn't
   * configured.
   */
  onBridleSessionClear(handler: BridleSessionClearHandler): void {
    const bridle = this.service.get("bridle")
    if (bridle instanceof ChannelGateway) {
      bridle.onSessionClear(handler)
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
   * Emit a live session-activity signal to the bridle hub (Phase 3 realtime
   * chat index). No-op when bridle isn't configured / connected.
   */
  reportSessionActivity(activity: SessionActivity): void {
    const bridle = this.service.get("bridle")
    if (bridle instanceof ChannelGateway) {
      bridle.reportActivity(activity)
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
    const results = await this.service.start()
    // Persist live state per channel so the platform (admin Channels tab)
    // sees connected/disconnected + reason instead of guessing from config
    // presence. The file rides the regular S3 sync.
    for (const r of results) {
      await this.writeStatus(r.name, r.ok, r.error)
    }
  }

  async stop(): Promise<void> {
    await this.service.stop()
  }

  async send(channel: string, to: string, text: string, parts?: MessagePart[]): Promise<void> {
    await this.service.send(channel, to, text, parts)
  }

  /**
   * Groups/rooms the bot works in, per channel — drives the channel_groups
   * tool. Telegram answers from its persisted registry, Slack from a live
   * API query; channels without the concept (bridle) are skipped.
   */
  async listGroups(channel?: string): Promise<Array<{ channel: string; groups: IChannelGroup[]; error?: string }>> {
    return this.service.listGroups(channel)
  }

  async streamSend(channel: string, to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void> {
    await this.service.streamSend(channel, to, streamer)
  }

  /** Best-effort typing signal to a channel's UI — no-op for channels without one. */
  async sendTyping(channel: string, to: string): Promise<void> {
    await this.service.sendTyping(channel, to)
  }

  /** Best-effort thinking-step publish — no-op for channels without thinking UI. */
  async sendThinking(channel: string, to: string, turnId: string, step?: IThinkingStep): Promise<void> {
    await this.service.sendThinking(channel, to, turnId, step)
  }

  // ── Runtime channel mutation ────────────────────────────────────────────
  // Tools call these to let the agent configure its own channels mid-session.
  // Persist-first, connect-second so a successful tool call survives restart;
  // a failed connect rolls the file back to its previous state.

  async setTelegram(entry: ITelegramFileEntry): Promise<void> {
    this.requireAgentDir("setTelegram")
    const prev = await loadTelegramFile(this.agentDir!)
    // Patch config fields only — the group registry living in the same file
    // survives a token change untouched.
    await updateTelegramFile(this.agentDir!, {
      botToken: entry.botToken,
      botName: entry.botName,
      adminIds: entry.adminIds,
      removed: undefined, // setting credentials clears a prior tombstone
    })
    try {
      await this.service.removeAndStop("telegram")
      const gateway = new ChannelGateway({
        type: "telegram",
        token: entry.botToken,
      }, this.agentDir)
      await this.service.addAndStart(gateway)
      this.activeKeys.set("telegram", entry.botToken)
      applyTelegramToEnv(entry)
      await this.writeStatus("telegram", true)
    } catch (err) {
      // Roll the file back so list() doesn't lie about state.
      await saveTelegramFile(this.agentDir!, prev)
      await this.writeStatus("telegram", false, (err as Error).message)
      throw err
    }
  }

  async setSlack(entry: ISlackFileEntry): Promise<void> {
    this.requireAgentDir("setSlack")
    const prev = await loadSlackFile(this.agentDir!)
    await saveSlackFile(this.agentDir!, entry)
    try {
      await this.service.removeAndStop("slack")
      const gateway = new ChannelGateway({
        type: "slack",
        botToken: entry.botToken,
        appToken: entry.appToken,
      })
      await this.service.addAndStart(gateway)
      this.activeKeys.set("slack", `${entry.botToken}\n${entry.appToken}`)
      process.env.SLACK_BOT_TOKEN = entry.botToken
      process.env.SLACK_APP_TOKEN = entry.appToken
      await this.writeStatus("slack", true)
    } catch (err) {
      await saveSlackFile(this.agentDir!, prev)
      await this.writeStatus("slack", false, (err as Error).message)
      throw err
    }
  }

  async removeChannel(type: ChannelFileType): Promise<boolean> {
    this.requireAgentDir("removeChannel")
    const path = type === "telegram"
      ? telegramFilePath(this.agentDir!)
      : slackFilePath(this.agentDir!)
    const hadFile = existsSync(path)
    // Tombstone instead of delete: the pod env keeps the old token until the
    // next redeploy, and a missing file would let the env fallback resurrect
    // the channel on restart. Credentials and the telegram group registry are
    // dropped on purpose (groups belong to that bot token; a future bot
    // rebuilds its own from my_chat_member updates).
    if (type === "telegram") await saveTelegramFile(this.agentDir!, { removed: true })
    else await saveSlackFile(this.agentDir!, { removed: true })
    this.activeKeys.delete(type)
    // A live channel may still exist even with no file (env-sourced).
    const stopped = await this.service.removeAndStop(type)
    await this.writeStatusGone(type)
    return hadFile || stopped
  }

  /**
   * Snapshot of currently configured channels for the channel_list tool and
   * the admin UI. Sources merge file + env so listing reflects what's
   * actually running.
   */
  async listInfo(): Promise<IChannelInfo[]> {
    const telegram = this.agentDir ? await loadTelegramFile(this.agentDir) : {}
    const slack = this.agentDir ? await loadSlackFile(this.agentDir) : {}
    const liveNames = new Set(this.service.listNames())
    const out: IChannelInfo[] = []

    if (telegram.removed) {
      // Explicitly removed — hide it even while the pod env still carries
      // the old token (until the next redeploy re-renders the env).
    } else if (telegram.botToken) {
      out.push({
        type: "telegram",
        source: "file",
        connected: liveNames.has("telegram"),
        config: maskTelegram(telegram),
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

    if (slack.removed) {
      // see the telegram tombstone note above
    } else if (slack.botToken && slack.appToken) {
      out.push({
        type: "slack",
        source: "file",
        connected: liveNames.has("slack"),
        config: maskSlack(slack),
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

  /**
   * Best-effort status persistence — a failed write must never take a
   * channel (or boot) down with it. `connected: null` is expressed by
   * dropping the entry (pass null via writeStatusGone).
   */
  private async writeStatus(type: string, connected: boolean, error?: string): Promise<void> {
    if (!this.agentDir || this.hasMock) return
    try {
      await updateChannelStatus(this.agentDir, type, {
        connected,
        ...(error ? { error } : {}),
        updatedAt: Date.now(),
      })
    } catch (err) {
      log.warn(`failed to persist ${type} status`, err)
    }
  }

  /** Drop a channel's status entry — its state is unknown, not disconnected. */
  private async writeStatusGone(type: string): Promise<void> {
    if (!this.agentDir || this.hasMock) return
    try {
      await updateChannelStatus(this.agentDir, type, null)
    } catch (err) {
      log.warn(`failed to drop ${type} status`, err)
    }
  }
}

/** Credential fingerprint for reconcile diffing; undefined for mock/bridle. */
function configKey(cfg: ChannelConfig): string | undefined {
  switch (cfg.type) {
    case "telegram": return cfg.token
    case "slack": return `${cfg.botToken}\n${cfg.appToken}`
    default: return undefined
  }
}

function applyTelegramToEnv(entry: ITelegramFile): void {
  // The runtime's access list and a couple of other consumers still read
  // these via process.env at construction time. Keep them in sync so a freshly
  // configured channel doesn't need a full restart to land in env-based reads.
  if (entry.botToken !== undefined) {
    process.env.TELEGRAM_BOT_TOKEN = entry.botToken
  }
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

function maskTelegram(entry: ITelegramFile): Record<string, string> {
  const out: Record<string, string> = { botToken: mask(entry.botToken) }
  if (entry.botName) out.botName = entry.botName
  if (entry.adminIds) out.adminIds = entry.adminIds
  if (entry.groups) out.knownGroups = String(Object.keys(entry.groups).length)
  return out
}

function maskSlack(entry: ISlackFile): Record<string, string> {
  return { botToken: mask(entry.botToken), appToken: mask(entry.appToken) }
}
