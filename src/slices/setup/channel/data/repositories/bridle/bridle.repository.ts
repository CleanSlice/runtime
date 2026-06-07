import type { IChannelGateway } from "../../../domain/channel.gateway"
import {
  MessagePartTypes,
  buildMessage,
  type Message,
  type MessagePart,
  type IMessageUiPart,
  type IMessageUiSubmitPart,
} from "../../../domain/channel.types"
import { isSilentReply, isSilentReplyPrefix } from "../../../../../agent/agent/domain/silentReply"
import { randomUUID } from "crypto"
import { io, type Socket } from "socket.io-client"
import { createLogger } from "../../../../logger"

const log = createLogger("bridle")

/** Wire part shape from the bridle protocol — superset of every type we
 *  speak with the hub. Field presence depends on `type`. */
interface WirePart {
  type: "text" | "image" | "file" | "ui" | "ui_submit"
  // text
  text?: string
  // image
  base64?: string
  mediaType?: string
  // file
  url?: string
  name?: string
  mimeType?: string
  // ui (agent → browser)
  uiId?: string
  components?: unknown[]
  submit?: { label?: string }
  // ui_submit (browser → agent)
  values?: Record<string, unknown>
}

/** Convert bridle wire parts → runtime MessagePart[]. Handles the full
 *  set; unknown types are dropped silently to stay forward-compatible
 *  with whatever the next SDK release adds. */
function wirePartsToMessageParts(wireParts: WirePart[]): MessagePart[] {
  const out: MessagePart[] = []
  for (const part of wireParts) {
    switch (part.type) {
      case "text":
        if (typeof part.text === "string") {
          out.push({ type: MessagePartTypes.Text, text: part.text })
        }
        break
      case "image":
        if (part.base64 && part.mediaType) {
          out.push({ type: MessagePartTypes.Image, base64: part.base64, mediaType: part.mediaType })
        }
        break
      case "file":
        if (part.url && part.name) {
          out.push({ type: MessagePartTypes.File, path: part.url, name: part.name, mimeType: part.mimeType })
        }
        break
      case "ui":
        // Components are user-supplied — pass them through. The SDK
        // validates the schema; the runtime treats them as opaque.
        if (part.uiId && Array.isArray(part.components)) {
          out.push({
            type: MessagePartTypes.Ui,
            uiId: part.uiId,
            components: part.components as IMessageUiPart["components"],
            ...(part.submit ? { submit: part.submit } : {}),
          })
        }
        break
      case "ui_submit":
        if (part.uiId && part.values && typeof part.values === "object") {
          out.push({
            type: MessagePartTypes.UiSubmit,
            uiId: part.uiId,
            values: part.values as IMessageUiSubmitPart["values"],
          })
        }
        break
    }
  }
  return out
}

/** Build a one-line human-readable summary of any ui_submit parts in
 *  the message, used to fill the empty `text` field when the visitor
 *  submitted a form. Example:
 *    "[form submitted] uiId=plan-pick · plan=pro · newsletter=yes"
 *  Returns "" if there are no ui_submit parts so callers can fall back
 *  to the original empty text. */
function summarizeUiSubmits(parts: MessagePart[]): string {
  const submits = parts.filter(
    (p): p is IMessageUiSubmitPart => p.type === MessagePartTypes.UiSubmit,
  )
  if (submits.length === 0) return ""
  return submits
    .map(s => {
      const pairs = Object.entries(s.values).map(([k, v]) => {
        if (typeof v === "boolean") return `${k}=${v ? "yes" : "no"}`
        if (Array.isArray(v)) return `${k}=${v.join(",")}`
        return `${k}=${String(v)}`
      })
      return `[form submitted] uiId=${s.uiId}${pairs.length ? " · " + pairs.join(" · ") : ""}`
    })
    .join("\n")
}

/** Convert runtime MessagePart[] → bridle wire parts. Mirrors the
 *  wire-to-message converter above. */
function messagePartsToWireParts(parts: MessagePart[]): WirePart[] {
  return parts.map(part => {
    switch (part.type) {
      case MessagePartTypes.Text:
        return { type: "text" as const, text: part.text }
      case MessagePartTypes.Image:
        return { type: "image" as const, base64: part.base64, mediaType: part.mediaType }
      case MessagePartTypes.File:
        return { type: "file" as const, url: part.path, name: part.name, mimeType: part.mimeType }
      case MessagePartTypes.Ui:
        return {
          type: "ui" as const,
          uiId: part.uiId,
          components: part.components,
          ...(part.submit ? { submit: part.submit } : {}),
        }
      case MessagePartTypes.UiSubmit:
        return {
          type: "ui_submit" as const,
          uiId: part.uiId,
          values: part.values,
        }
    }
  })
}

/** Callback invoked when the hub asks the agent to push its files to S3. */
export type BridleSyncHandler = () => Promise<{ pushed: number }>

/**
 * Snapshot of an LLM round-trip for the admin debug panel. Sent over the
 * "debug" wire event; the hub only relays it to admin clients.
 */
export interface IBridleDebugPayload {
  messageId?: string
  model: string
  provider: string
  systemPrompt: string
  history: unknown[]
  response: {
    text: string
    toolCalls?: Array<{ name: string; params: unknown }>
    stopReason?: string
  }
  usage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    credentialId?: string
  }
  latencyMs: number
}

/**
 * Bridle channel — agent connects TO the Bridle hub (NestJS API) as a socket.io client.
 * The hub relays messages between browser users and this agent.
 *
 * Flow:  Browser ↔ /ws/client ↔ Bridle Hub ↔ /ws/agent ↔ Agent (this)
 *
 * Auth: BRIDLE_API_KEY + BRIDLE_AGENT_ID in Socket.IO handshake.
 *
 * Wire protocol carries `parts: BridlePart[]` for rich content (text, images, files).
 */
export class BridleRepository implements IChannelGateway {
  readonly name = "bridle"

  private handler?: (msg: Message) => Promise<void>
  private syncHandler?: BridleSyncHandler
  private socket: Socket | null = null
  private apiUrl: string
  /**
   * Server-pushed debug flag. Updated via "debug_set" WS event from the
   * hub. Defaults to false so a fresh agent doesn't leak prompts before
   * the hub has had a chance to rehydrate the value from DB.
   */
  private debugEnabled = false

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl
  }

  /**
   * Register a handler to run when the hub sends a `sync` command.
   * The handler should push the agent's local files to S3 and return the
   * number of files actually pushed.
   */
  onSync(handler: BridleSyncHandler): void {
    this.syncHandler = handler
  }

  async start(): Promise<void> {
    this.connect()
  }

  async stop(): Promise<void> {
    this.socket?.disconnect()
    this.socket = null
    log.info("channel stopped")
  }

  async send(to: string, text: string, parts?: MessagePart[]): Promise<void> {
    const wireParts = parts ? messagePartsToWireParts(parts) : (text ? [{ type: "text" as const, text }] : [])
    this.socket?.emit("message", {
      clientId: to,
      text,
      parts: wireParts,
      messageId: randomUUID(),
      ts: Date.now(),
    })
  }

  /**
   * Best-effort debug emission. Silent no-op if the socket is offline — debug
   * traces are always disposable; we never want to block the chat path.
   */
  sendDebug(to: string, payload: IBridleDebugPayload): void {
    if (!this.socket?.connected) return
    this.socket.emit("debug", {
      type: "debug",
      clientId: to,
      ts: Date.now(),
      ...payload,
    })
  }

  /** Whether the hub has told us debug is on for this bot. */
  isDebugEnabled(): boolean {
    return this.debugEnabled
  }

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.handler = handler
  }

  async streamSend(to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void> {
    const messageId = randomUUID()

    if (!this.socket?.connected) {
      log.warn("streamSend: socket not connected, falling back to non-streaming")
      await streamer(() => {})
      return
    }

    log.info(`stream start (clientId=${to} messageId=${messageId.slice(0, 8)})`)
    this.socket.emit("typing", { clientId: to, ts: Date.now() })

    let lastSent = ""
    let pendingText = ""
    let sending = false
    let chunksEmitted = 0

    // Hold chunk emission while accumulated text is still a prefix of the
    // silent-reply sentinel, so the browser never sees "N" / "NO_REP" before
    // we know the model is going to emit NO_REPLY.
    const flush = () => {
      if (sending || pendingText === lastSent) return
      if (isSilentReplyPrefix(pendingText)) return
      sending = true
      const toSend = pendingText
      this.socket?.emit("stream", {
        clientId: to,
        text: toSend,
        parts: [{ type: "text", text: toSend }],
        messageId,
        ts: Date.now(),
      })
      lastSent = toSend
      chunksEmitted++
      sending = false
    }

    const interval = setInterval(flush, 100)

    let finalText = ""
    try {
      finalText = await streamer((accumulated: string) => {
        pendingText = accumulated
      })
    } finally {
      clearInterval(interval)
      // Tool-only LLM iterations stream no text and return ""; emitting
      // stream_end here would create an empty bubble in the UI. Skip when
      // we never streamed anything and have nothing to finalize.
      // Silent-reply sentinel: even if chunks were never emitted (held by
      // the prefix guard), don't emit stream_end with NO_REPLY content.
      if ((chunksEmitted > 0 || finalText.length > 0) && !isSilentReply(finalText)) {
        this.socket?.emit("stream_end", {
          clientId: to,
          text: finalText,
          parts: [{ type: "text", text: finalText }],
          messageId,
          ts: Date.now(),
        })
      }
      log.info(
        `stream end (messageId=${messageId.slice(0, 8)}, ` +
        `chunks=${chunksEmitted}, length=${finalText.length}${isSilentReply(finalText) ? ", silent" : ""})`,
      )
    }
  }

  private connect(): void {
    const url = this.apiUrl
    log.info(`connecting to hub at ${url}`)

    this.socket = io(url, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity,
      auth: {
        apiKey: process.env.BRIDLE_API_KEY ?? "",
        // Prefer BRIDLE_AGENT_ID; fall back to BRIDLE_BOT_ID so older
        // workflow templates / .env files keep working through the rename.
        agentId:
          process.env.BRIDLE_AGENT_ID ?? process.env.BRIDLE_BOT_ID ?? "",
      },
    })

    this.socket.on("connect", () => {
      log.info("connected to hub")
      this.socket?.emit("register", {})
    })

    this.socket.on("disconnect", (reason) => {
      log.info(`disconnected from hub: ${reason}`)
    })

    this.socket.on("reconnect", () => {
      log.info("reconnected to hub")
      this.socket?.emit("register", {})
    })

    this.socket.on("message", (data: unknown) => {
      const msg = data as Record<string, unknown>
      if (!msg?.clientId || !this.handler) return

      const wireText = (msg.text as string) ?? ""
      const wireParts = (msg.parts as WirePart[]) ?? []
      // Decode the full wire payload — text/image/file/ui/ui_submit alike.
      // `parts` overrides the legacy text/images/files extraction so the
      // ui parts survive into the agent's Message.
      const parts = wirePartsToMessageParts(wireParts)
      // Capabilities are forwarded by the hub on every message (Bridle SDK
      // ≥ v0.12.0 sets them at handshake). Drop them on the Message so any
      // onMessage handler can capability-gate `ui` parts before emitting.
      const capabilities = Array.isArray(msg.capabilities)
        ? (msg.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
        : undefined

      // Integrator context from the embed's `data-prompt`. The hub forwards it
      // on every message; carry it onto the Message so the runtime can fold it
      // into the system prompt (otherwise the agent never sees it).
      const prompt = typeof msg.prompt === "string" && msg.prompt.trim()
        ? msg.prompt
        : undefined

      // When the visitor submits a form, the SDK ships an empty text + a
      // ui_submit part. Synthesize a readable summary so the LLM sees the
      // turn as a normal user message (LLMs that only get text/images
      // wouldn't otherwise know the user did anything).
      const text = wireText.trim() ? wireText : summarizeUiSubmits(parts)

      this.handler(buildMessage({
        id: (msg.messageId as string) ?? randomUUID(),
        text,
        from: msg.clientId as string,
        channel: "bridle",
        ts: Date.now(),
        parts,
        ...(capabilities ? { capabilities } : {}),
        ...(prompt ? { prompt } : {}),
        metadata: { clientId: msg.clientId, source: "bridle" },
      })).catch(err => log.error("handler error", err))
    })

    this.socket.on("debug_set", (data: unknown) => {
      const msg = data as { enabled?: boolean }
      const next = !!msg?.enabled
      if (this.debugEnabled !== next) {
        log.info(`debug ${next ? "enabled" : "disabled"} by hub`)
      }
      this.debugEnabled = next
    })

    this.socket.on("sync", async (data: unknown) => {
      const msg = data as { requestId?: string }
      const requestId = msg?.requestId
      if (!requestId) return
      if (!this.syncHandler) {
        this.socket?.emit("sync_done", {
          requestId,
          pushed: 0,
          error: "Sync handler not registered on agent",
        })
        return
      }
      try {
        const { pushed } = await this.syncHandler()
        this.socket?.emit("sync_done", { requestId, pushed })
      } catch (err) {
        this.socket?.emit("sync_done", {
          requestId,
          pushed: 0,
          error: (err as Error)?.message ?? "Unknown sync error",
        })
      }
    })

    this.socket.on("connect_error", (err) => {
      log.error(`connection error: ${err.message}`)
    })
  }

}
