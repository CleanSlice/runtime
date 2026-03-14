import type { Message } from "../../../domain/channel.types"
import { randomUUID } from "crypto"

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: { id: number; username?: string }
    chat: { id: number }
    text?: string
    date: number
  }
}

export class TelegramRepository {
  private offset = 0
  private running = false
  private handler?: (msg: Message) => Promise<void>
  private baseUrl: string

  constructor(private token: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.running = true
    this.poll()
  }

  async stop(): Promise<void> {
    this.running = false
  }

  async send(chatId: string, text: string): Promise<void> {
    await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    })
  }

  async sendTyping(chatId: string): Promise<void> {
    await fetch(`${this.baseUrl}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    })
  }

  private async poll(): Promise<void> {
    console.log("[telegram] polling started")
    while (this.running) {
      try {
        const res = await fetch(`${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=30`)
        if (!res.ok) { await this.wait(5000); continue }

        const json = (await res.json()) as { ok: boolean; result: TelegramUpdate[]; description?: string }
        if (!json.ok) { await this.wait(5000); continue }

        for (const update of json.result) {
          this.offset = update.update_id + 1
          const msg = update.message
          if (msg?.text && this.handler) {
            const chatId = String(msg.chat.id)

            // Show typing indicator immediately
            await this.sendTyping(chatId)

            // Keep typing indicator alive while processing
            const typingInterval = setInterval(() => this.sendTyping(chatId), 4000)

            try {
              await this.handler({
                id: randomUUID(),
                text: msg.text,
                from: chatId,
                channel: "telegram",
                ts: msg.date * 1000,
                sessionId: "",
                metadata: { chatId: msg.chat.id, username: msg.from?.username },
              })
            } finally {
              clearInterval(typingInterval)
            }
          }
        }
      } catch {
        await this.wait(5000)
      }
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
  }
}
