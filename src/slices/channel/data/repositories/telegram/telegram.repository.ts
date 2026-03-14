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
      body: JSON.stringify({ chat_id: chatId, text }),
    })
  }

  private async poll(): Promise<void> {
    console.log("[telegram] polling started")
    while (this.running) {
      try {
        const res = await fetch(`${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=30`)
        if (!res.ok) { console.log("[telegram] fetch error", res.status); await this.wait(5000); continue }

        const json = (await res.json()) as { ok: boolean; result: TelegramUpdate[]; description?: string }
        if (!json.ok) { console.log("[telegram] api error:", json.description); await this.wait(5000); continue }

        console.log(`[telegram] updates: ${json.result.length}, offset: ${this.offset}`)
        for (const update of json.result) {
          this.offset = update.update_id + 1
          const msg = update.message
          console.log(`[telegram] update: text="${msg?.text}" handler=${!!this.handler}`)
          if (msg?.text && this.handler) {
            await this.handler({
              id: randomUUID(),
              text: msg.text,
              from: String(msg.from?.id ?? msg.chat.id),
              channel: "telegram",
              ts: msg.date * 1000,
              sessionId: "",
              metadata: { chatId: msg.chat.id, username: msg.from?.username },
            })
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
