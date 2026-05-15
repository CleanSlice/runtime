import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

// Channel tools let the agent configure its own messaging connections from
// chat. Tokens land in <agentDir>/data/channels.json (persisted, S3-synced)
// and the channel connects immediately — no pod restart needed.
//
// Bridle is intentionally NOT exposed here. It's the bootstrap channel the
// runtime can't reconfigure without losing the very link that delivers tool
// calls. It stays env-only.

async function validateTelegramToken(
  token: string,
): Promise<{ ok: boolean; username?: string; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const data = await res.json() as {
      ok: boolean
      result?: { username?: string; first_name?: string }
      description?: string
    }
    if (!data.ok) {
      return { ok: false, error: data.description || `Telegram API returned not-ok` }
    }
    return { ok: true, username: data.result?.username }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export const ChannelTelegramSetTool: Tool = {
  name: "channel_telegram_set",
  description:
    "Configure (or replace) this agent's Telegram bot. Provide the bot token from @BotFather; bot name auto-detects from the token if omitted. The bot starts receiving messages immediately after a successful save. Admin-only.",
  adminOnly: true,
  schema: z.object({
    botToken: z.string().describe("Telegram bot HTTP API token (from @BotFather)"),
    botName: z
      .string()
      .optional()
      .describe("Public username without @ — auto-detected from the token when omitted"),
    adminIds: z
      .string()
      .optional()
      .describe("Comma-separated Telegram chat IDs treated as bot admins (defaults to current admin list)"),
  }),
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { botToken, botName, adminIds } =
      (ChannelTelegramSetTool.schema as ReturnType<typeof z.object>).parse(params) as {
        botToken: string
        botName?: string
        adminIds?: string
      }
    if (!ctx.channels) {
      return { error: "Channel registry not available in this context" }
    }
    const valid = await validateTelegramToken(botToken)
    if (!valid.ok) {
      return { error: `Invalid Telegram token: ${valid.error}` }
    }
    const resolvedName = botName ?? valid.username
    try {
      await ctx.channels.setTelegram({
        botToken,
        botName: resolvedName,
        adminIds,
      })
      return {
        ok: true,
        botName: resolvedName,
        message: resolvedName
          ? `Telegram channel connected as @${resolvedName}.`
          : "Telegram channel connected.",
        note: adminIds
          ? "adminIds saved — already-running access checks pick up new admins on the next agent restart."
          : undefined,
      }
    } catch (err) {
      return { error: `Failed to connect Telegram: ${(err as Error).message}` }
    }
  },
}

export const ChannelRemoveTool: Tool = {
  name: "channel_remove",
  description:
    "Disconnect a configured channel and remove it from channels.json. Use to stop receiving messages on that platform. Bridle cannot be removed this way — it's the bootstrap channel.",
  adminOnly: true,
  schema: z.object({
    type: z.enum(["telegram", "slack"]).describe("Channel type to remove"),
  }),
  async execute(params: unknown, ctx: ToolContext): Promise<unknown> {
    const { type } =
      (ChannelRemoveTool.schema as ReturnType<typeof z.object>).parse(params) as {
        type: "telegram" | "slack"
      }
    if (!ctx.channels) {
      return { error: "Channel registry not available in this context" }
    }
    try {
      const removed = await ctx.channels.removeChannel(type)
      return removed
        ? { ok: true, removed: type }
        : { ok: false, message: `No ${type} channel was configured.` }
    } catch (err) {
      return { error: `Failed to remove ${type}: ${(err as Error).message}` }
    }
  },
}

export const ChannelListTool: Tool = {
  name: "channel_list",
  description:
    "List currently configured channels with their source (file or env), live connection state, and masked credentials. Bridle, when present, is always env-sourced.",
  schema: z.object({}),
  async execute(_params: unknown, ctx: ToolContext): Promise<unknown> {
    if (!ctx.channels) {
      return { error: "Channel registry not available in this context" }
    }
    return { channels: await ctx.channels.listInfo() }
  },
}
