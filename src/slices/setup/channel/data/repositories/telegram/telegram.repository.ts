import { buildMessage, type IChannelGroup, type Message } from "../../../domain/channel.types"
import { isSilentReply, isSilentReplyPrefix } from "../../../../../agent/agent/domain/silentReply"
import { randomUUID } from "crypto"
import { createLogger } from "../../../../logger"
import {
  type ITelegramGroupEntry,
  loadTelegramFile,
  updateTelegramFile,
} from "./telegramFile"

const log = createLogger("telegram")

interface TelegramChat {
  id: number
  type: "private" | "group" | "supergroup" | "channel"
  title?: string
  username?: string
}

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    from?: {
      id: number
      username?: string
      first_name?: string
      last_name?: string
      language_code?: string   // client UI language, e.g. "en", "ru" — base code only, no region
      is_premium?: boolean     // has Telegram Premium
      is_bot?: boolean
    }
    chat: TelegramChat
    text?: string
    date: number
    photo?: Array<{ file_id: string; file_size: number; width: number; height: number }>
    caption?: string
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
    reply_to_message?: {
      from?: { id: number; username?: string; is_bot?: boolean }
    }
  }
  // Fires when the bot itself is added to / removed from / promoted in a chat.
  // Delivered by default (no allowed_updates opt-in needed).
  my_chat_member?: {
    chat: TelegramChat
    date: number
    new_chat_member: { status: string; user: { id: number; is_bot?: boolean } }
  }
}

const GROUP_CONTEXT_MAX = 20

export class TelegramRepository {
  private offset = 0
  private running = false
  private handler?: (msg: Message) => Promise<void>
  private baseUrl: string
  private botUsername: string | null = null
  private groupContext: Map<string, Array<{ name: string; text: string }>> = new Map()
  // Registry of groups/channels the bot works in — persisted into
  // <agentDir>/data/channels/telegram.json when agentDir is provided.
  private groups: Map<string, ITelegramGroupEntry> = new Map()

  constructor(private token: string, private agentDir?: string) {
    this.baseUrl = `https://api.telegram.org/bot${token}`
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    this.running = true
    await this.loadGroups()
    await this.fetchBotInfo()
    await this.registerCommands()
    this.poll()
  }

  /** Channel-agnostic view of the group registry — freshest first. */
  listGroups(): Promise<IChannelGroup[]> {
    const groups = [...this.groups.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(g => ({
        id: g.id,
        name: g.title,
        username: g.username,
        type: g.type,
        status: g.status,
        lastSeenAt: g.lastSeenAt,
      }))
    return Promise.resolve(groups)
  }

  private async loadGroups(): Promise<void> {
    if (!this.agentDir) return
    const file = await loadTelegramFile(this.agentDir)
    for (const [id, entry] of Object.entries(file.groups ?? {})) {
      this.groups.set(id, entry)
    }
    if (this.groups.size) log.info(`loaded ${this.groups.size} known group(s)`)
  }

  private saveGroups(): void {
    if (!this.agentDir) return
    // Patches only `groups` — bot config in the same file stays intact.
    updateTelegramFile(this.agentDir, { groups: Object.fromEntries(this.groups) })
      .catch(err => log.error("failed to persist groups", err))
  }

  /**
   * Upsert a group/channel the bot sees. `status` comes from my_chat_member
   * updates; plain group messages leave it unchanged. Persists only on
   * meaningful change (new chat, title/username/type/status) so a busy group
   * doesn't rewrite the file on every message — lastSeenAt still updates
   * in memory and rides along with the next persisted change.
   */
  private trackGroup(chat: TelegramChat, ts: number, status?: string): void {
    if (chat.type === "private") return
    const id = String(chat.id)
    const prev = this.groups.get(id)
    const next: ITelegramGroupEntry = {
      id,
      type: chat.type,
      title: chat.title ?? prev?.title,
      username: chat.username ?? prev?.username,
      status: status ?? prev?.status ?? "member",
      addedAt: prev?.addedAt ?? ts,
      lastSeenAt: ts,
    }
    this.groups.set(id, next)
    const changed = !prev
      || prev.title !== next.title
      || prev.username !== next.username
      || prev.type !== next.type
      || prev.status !== next.status
    if (changed) {
      log.info(`group ${next.title ?? id} (${id}) → ${next.status}`)
      this.saveGroups()
    }
  }

  private async fetchBotInfo(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/getMe`)
      const json = await res.json() as { ok: boolean; result: { username?: string } }
      if (json.ok && json.result.username) {
        this.botUsername = json.result.username.toLowerCase()
        log.info(`bot username @${this.botUsername}`)
      }
    } catch (err) {
      log.error("failed to fetch bot info", err)
    }
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
      log.info("commands registered")
    } catch (err) {
      log.error("failed to register commands", err)
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

  private addToGroupContext(chatId: string, name: string, text: string): void {
    const buffer = this.groupContext.get(chatId) ?? []
    buffer.push({ name, text: text.slice(0, 200) })
    if (buffer.length > GROUP_CONTEXT_MAX) {
      buffer.splice(0, buffer.length - GROUP_CONTEXT_MAX)
    }
    this.groupContext.set(chatId, buffer)
  }

  private buildGroupContextString(chatId: string): string {
    const buffer = this.groupContext.get(chatId)
    if (!buffer?.length) return ""
    return buffer.map(m => `${m.name}: ${m.text}`).join("\n")
  }

  private async poll(): Promise<void> {
    log.info("polling started")
    while (this.running) {
      try {
        const res = await fetch(`${this.baseUrl}/getUpdates?offset=${this.offset}&timeout=30`)
        if (!res.ok) { await this.wait(5000); continue }

        const json = (await res.json()) as { ok: boolean; result: TelegramUpdate[]; description?: string }
        if (!json.ok) { await this.wait(5000); continue }

        for (const update of json.result) {
          this.offset = update.update_id + 1

          // Membership change: bot added to / removed from / promoted in a chat
          const member = update.my_chat_member
          if (member) {
            this.trackGroup(member.chat, member.date * 1000, member.new_chat_member.status)
            continue
          }

          const msg = update.message
          const hasText = !!msg?.text
          const hasPhoto = !!msg?.photo?.length
          const hasDocument = !!msg?.document
          if (!((hasText || hasPhoto || hasDocument) && this.handler)) continue

          const chatId = String(msg!.chat.id)
          const isGroup = msg!.chat.type !== "private"

          // Group message handling: track context, only respond to @mentions/replies
          let groupPriorContext = ""
          let groupSenderName = ""
          let groupChatTitle = ""

          if (isGroup) {
            // Every group message keeps the registry fresh — covers groups the
            // bot joined before my_chat_member tracking existed.
            this.trackGroup(msg!.chat, msg!.date * 1000)

            const rawText = msg!.text ?? msg!.caption ?? ""
            groupSenderName = msg!.from?.username
              ? `@${msg!.from.username}`
              : (msg!.from?.first_name ?? "user")
            groupChatTitle = msg!.chat.title ?? ""

            // Snapshot context BEFORE this message, then add this message
            groupPriorContext = this.buildGroupContextString(chatId)
            if (rawText) this.addToGroupContext(chatId, groupSenderName, rawText)

            const isMentioned = !!this.botUsername &&
              rawText.toLowerCase().includes(`@${this.botUsername}`)
            const isReplyToBot =
              msg!.reply_to_message?.from?.username?.toLowerCase() === this.botUsername

            if (!isMentioned && !isReplyToBot) continue
          }

          const handler = this.handler

          // Process each message in parallel — don't block poll loop
          ;(async () => {
            await this.sendTyping(chatId)
            const typingInterval = setInterval(() => this.sendTyping(chatId), 4000)
            try {
              let text = msg!.text ?? msg!.caption ?? (hasPhoto ? "[photo]" : "[document]")
              const metadata: Record<string, unknown> = {
                chatId: msg!.chat.id,
                username: msg!.from?.username,
                fromUserId: msg!.from?.id,
                firstName: msg!.from?.first_name,
                lastName: msg!.from?.last_name,
                languageCode: msg!.from?.language_code,
                isPremium: msg!.from?.is_premium,
                channel: isGroup ? "group" : "dm",
              }

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
                  log.error("failed to download photo for vision", err)
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

              // Group-specific: strip @mention and prepend discussion context
              if (isGroup) {
                if (this.botUsername) {
                  text = text.replace(new RegExp(`@${this.botUsername}`, "gi"), "").trim()
                }
                if (groupPriorContext) {
                  text = `[Recent group discussion]\n${groupPriorContext}\n\n[From ${groupSenderName}] ${text || "(no text)"}`
                } else {
                  text = `[From ${groupSenderName} in group] ${text}`
                }
                metadata.isGroup = true
                metadata.fromName = groupSenderName
                metadata.chatTitle = groupChatTitle
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
          })().catch(err => log.error("message handler error", err))
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
