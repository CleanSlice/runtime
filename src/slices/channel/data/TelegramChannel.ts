import type { Channel } from "../domain/Channel"
import type { Message } from "../../../shared/types/Message"
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

export class TelegramChannel implements Channel {
  readonly name = "telegram"
  private token: string
  private offset = 0
  private running = false
  private handler?: (msg: Message) => Promise<void>
  private baseUrl: string

  constructor({ token }: { token: string }) {
    this.token = token
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

  async send(to: string, text: string): Promise<void> {
    await fetch(`${this.baseUrl}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: to, text }),
    })
  }

  private async poll(): Promise<void> {
    while (this.running) {
      try {
        const res = await fetch(
          `${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=30`
        )
        if (!res.ok) {
          await new Promise(r => setTimeout(r, 5000))
          continue
        }
        const json = (await res.json()) as { ok: boolean; result: TelegramUpdate[] }
        if (!json.ok) continue

        for (const update of json.result) {
          this.offset = update.update_id + 1
          if (update.message?.text && this.handler) {
            const msg: Message = {
              id: randomUUID(),
              text: update.message.text,
              from: String(update.message.from?.id ?? update.message.chat.id),
              channel: "telegram",
              ts: update.message.date * 1000,
              sessionId: "",
              metadata: {
                chatId: update.message.chat.id,
                username: update.message.from?.username,
              },
            }
            await this.handler(msg)
          }
        }
      } catch {
        await new Promise(r => setTimeout(r, 5000))
      }
    }
  }
}
