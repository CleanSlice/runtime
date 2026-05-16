import { buildMessage, type Message } from "../../../domain/channel.types"
import { isSilentReply, isSilentReplyPrefix } from "../../../../../agent/agent/domain/silentReply"
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
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
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
    await this.registerCommands()
    this.poll()
  }

  private async registerCommands(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/setMyCommands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commands: [
            { command: "start",  description: "Start the agent" },
            { command: "help",   description: "Show available commands" },
            { command: "status", description: "Agent status" },
            { command: "clear",  description: "Reset current session" },
            { command: "memory", description: "What the agent remembers about you" },
            { command: "tasks",  description: "List active tasks" },
            { command: "voice",  description: "Toggle voice mode" },
          ],
        }),
      })
      console.log("[telegram] commands registered")
    } catch (err) {
      console.error("[telegram] failed to register commands:", err)
    }
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

  /**
   * Delete a message — used to remove "…" placeholders when LLM returns only tool calls (no text).
   */
  async deleteMessage(chatId: string, messageId: number): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/deleteMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
      })
    } catch {
      // Ignore
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
      if (isSilentReply(text)) return
      await this.send(chatId, text)
      return
    }

    let lastSent = "…"
    let pendingText = ""
    let editing = false

    // Throttled edit — at most once per 600ms to avoid Telegram rate limits (30 edits/min).
    // Holds when the accumulated text is still a prefix of the silent-reply sentinel — the
    // user never sees "N" / "NO_REP" leak from a model that's about to emit NO_REPLY.
    const flushEdit = async () => {
      if (editing || pendingText === lastSent) return
      if (isSilentReplyPrefix(pendingText)) return
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

    let finalText = ""
    try {
      finalText = await streamer((accumulated: string) => {
        pendingText = accumulated
      })
      pendingText = finalText
    } finally {
      clearInterval(interval)
      if (isSilentReply(finalText)) {
        // Sentinel: model chose to stay silent — drop the placeholder.
        await this.deleteMessage(chatId, messageId)
      } else if (finalText && finalText !== lastSent) {
        // Final edit with complete text
        await this.editMessage(chatId, messageId, finalText)
      } else if (!finalText) {
        // No text came through (tool-call-only response) — delete the "…" placeholder
        await this.deleteMessage(chatId, messageId)
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
          const hasDocument = !!msg?.document
          if ((hasText || hasPhoto || hasDocument) && this.handler) {
            const chatId = String(msg!.chat.id)
            const handler = this.handler

            // Process each message in parallel — don't block poll loop
            ;(async () => {
              await this.sendTyping(chatId)
              const typingInterval = setInterval(() => this.sendTyping(chatId), 4000)
              try {
                let text = msg!.text ?? msg!.caption ?? (hasPhoto ? "[photo]" : "[document]")
                const metadata: Record<string, unknown> = { chatId: msg!.chat.id, username: msg!.from?.username }

                const images: Array<{ base64: string; mediaType: string }> = []

                if (hasPhoto) {
                  const fileId = msg!.photo![msg!.photo!.length - 1].file_id
                  const fileRes = await fetch(`${this.baseUrl}/getFile?file_id=${fileId}`)
                  const fileJson = (await fileRes.json()) as { result: { file_path: string } }
                  const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileJson.result.file_path}`
                  metadata.photoUrl = fileUrl
                  metadata.hasPhoto = true

                  // Download image and convert to base64 for native vision
                  try {
                    const imgRes = await fetch(fileUrl)
                    if (imgRes.ok) {
                      const buffer = await imgRes.arrayBuffer()
                      const base64 = Buffer.from(buffer).toString("base64")
                      // Claude API accepts only: image/jpeg, image/png, image/gif, image/webp
                      const rawType = (imgRes.headers.get("content-type") ?? "").split(";")[0].trim()
                      const validTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
                      const mediaType = validTypes.has(rawType) ? rawType : "image/jpeg"
                      images.push({ base64, mediaType })
                    }
                  } catch (err) {
                    console.error("[telegram] failed to download photo for vision:", err)
                  }

                  const caption = msg!.caption ? msg!.caption : ""
                  text = caption || "[User sent a photo]"
                }

                if (hasDocument) {
                  const doc = msg!.document!
                  const fileRes = await fetch(`${this.baseUrl}/getFile?file_id=${doc.file_id}`)
                  const fileJson = (await fileRes.json()) as { result: { file_path: string } }
                  const fileUrl = `https://api.telegram.org/file/bot${this.token}/${fileJson.result.file_path}`
                  const fileName = doc.file_name ?? fileJson.result.file_path.split("/").pop() ?? "file"
                  const localPath = `/tmp/${fileName}`
                  const fileData = await fetch(fileUrl)
                  await Bun.write(localPath, await fileData.arrayBuffer())
                  metadata.documentPath = localPath
                  metadata.documentName = fileName
                  metadata.hasDocument = true
                  const caption = msg!.caption ? ` Caption: "${msg!.caption}"` : ""
                  text = `[User sent a file: ${fileName}]${caption}\nLocal path: ${localPath}\nProcess this file as needed.`
                }

                await handler(buildMessage({
                  id: randomUUID(),
                  text,
                  from: chatId,
                  channel: "telegram",
                  ts: msg!.date * 1000,
                  ...(images.length > 0 ? { images } : {}),
                  metadata,
                }))
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
