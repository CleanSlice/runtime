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
    photo?: Array<{ file_id: string; file_size: number; width: number; height: number }>
    caption?: string
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

  /**
   * Send an empty placeholder message and return its message_id.
   * Used to start streaming — we edit this message as tokens arrive.
   */
  async sendPlaceholder(chatId: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.baseUrl}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "…", parse_mode: "Markdown" }),
      })
      const json = (await res.json()) as { ok: boolean; result?: { message_id: number } }
      return json.result?.message_id ?? null
    } catch {
      return null
    }
  }

  /**
   * Edit an existing message — used to stream content progressively.
   */
  async editMessage(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "Markdown" }),
      })
    } catch {
      // Ignore edit errors — message may already be up to date
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await fetch(`${this.baseUrl}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    })
  }

  /**
   * Stream text to Telegram: sends placeholder "…", then edits every ~500ms as chunks arrive.
   * streamer is a function that calls onChunk(accumulatedText) and returns final text.
   */
  async streamSend(chatId: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void> {
    const messageId = await this.sendPlaceholder(chatId)
    if (!messageId) {
      // Fallback: just get the full text and send
      const text = await streamer(() => {})
      await this.send(chatId, text)
      return
    }

    let lastSent = "…"
    let pendingText = ""
    let editing = false

    // Throttled edit — at most once per 600ms to avoid Telegram rate limits (30 edits/min)
    const flushEdit = async () => {
      if (editing || pendingText === lastSent) return
      editing = true
      const toSend = pendingText
      try {
        await this.editMessage(chatId, messageId, toSend || "…")
        lastSent = toSend
      } finally {
        editing = false
      }
    }

    const interval = setInterval(() => flushEdit(), 600)

    try {
      const finalText = await streamer((accumulated: string) => {
        pendingText = accumulated
      })
      pendingText = finalText
    } finally {
      clearInterval(interval)
      // Final edit with complete text
      if (pendingText && pendingText !== lastSent) {
        await this.editMessage(chatId, messageId, pendingText)
      }
    }
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
          const hasText = !!msg?.text
          const hasPhoto = !!msg?.photo?.length
          if ((hasText || hasPhoto) && this.handler) {
            const chatId = String(msg!.chat.id)
            const handler = this.handler

            // Process each message in parallel — don't block poll loop
            ;(async () => {
              await this.sendTyping(chatId)
              const typingInterval = setInterval(() => this.sendTyping(chatId), 4000)
              try {
                let text = msg!.text ?? msg!.caption ?? "[photo]"
                const metadata: Record<string, unknown> = { chatId: msg!.chat.id, username: msg!.from?.username }

                if (hasPhoto) {
                  const fileId = msg!.photo![msg!.photo!.length - 1].file_id
                  const fileRes = await fetch(`${this.baseUrl}/getFile?file_id=${fileId}`)
                  const fileJson = (await fileRes.json()) as { result: { file_path: string } }
                  const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileJson.result.file_path}`
                  metadata.photoUrl = fileUrl
                  metadata.hasPhoto = true
                  // Include URL in text so LLM can analyze it
                  const caption = msg!.caption ? ` Caption: "${msg!.caption}"` : ""
                  text = `[User sent a photo]${caption}\nPhoto URL: ${fileUrl}\nPlease analyze this image using the image_analyze tool.`
                }

                await handler({
                  id: randomUUID(),
                  text,
                  from: chatId,
                  channel: "telegram",
                  ts: msg!.date * 1000,
                  sessionId: "",
                  metadata,
                })
              } finally {
                clearInterval(typingInterval)
              }
            })().catch(err => console.error("[telegram] message handler error:", err))
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
