import { z } from "zod"
import type { Tool, ToolContext } from "../../../domain/tool.types"

const schema = z.object({
  chat_id: z.string().describe("Telegram chat ID to send the message to"),
  text: z.string().describe("Message text to send"),
  parse_mode: z.enum(["Markdown", "HTML"]).optional().describe("Parse mode for message formatting"),
})

export const TelegramSendTool: Tool = {
  name: "telegram_send",
  description: "Send a Telegram message to any chat ID. Use this to proactively message users. For group chats, resolve the chat ID first via channel_groups.",
  schema,
  adminOnly: true,
  async execute(params: unknown, _ctx: ToolContext): Promise<unknown> {
    const { chat_id, text, parse_mode } = schema.parse(params)

    const token = process.env.TELEGRAM_BOT_TOKEN
    if (!token) {
      return { error: "TELEGRAM_BOT_TOKEN environment variable is not set" }
    }

    const body: Record<string, unknown> = { chat_id, text }
    if (parse_mode) body.parse_mode = parse_mode

    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    const data = await res.json() as { ok: boolean; description?: string; result?: unknown }

    if (!data.ok) {
      return { error: `Telegram API error: ${data.description}` }
    }

    return { ok: true, sent: true, chat_id }
  },
}
