import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

// Lets the agent configure its own Telegram bot from chat. The config lands
// in <agentDir>/data/channels/telegram.json (persisted, S3-synced) alongside
// the group registry, and the channel connects immediately — no pod restart
// needed. Tool name stays `channel_telegram_set` for backward compatibility
// with existing skills and prompts.

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
