import type { IChannelGateway } from "../../../domain/channel.gateway"
import { MessagePartTypes, buildMessage, type Message, type MessagePart } from "../../../domain/channel.types"
import { randomUUID } from "crypto"
import { io, type Socket } from "socket.io-client"

/** Wire part types from bridle protocol */
interface WirePart {
  type: "text" | "image" | "file"
  text?: string
  base64?: string
  mediaType?: string
  url?: string
  name?: string
  mimeType?: string
}

/** Extract images and files from wire parts for buildMessage() */
function extractMediaFromWireParts(wireParts: WirePart[]): { images?: Array<{ base64: string; mediaType: string }>; files?: Array<{ path: string; name: string; mimeType?: string }> } {
  const images: Array<{ base64: string; mediaType: string }> = []
  const files: Array<{ path: string; name: string; mimeType?: string }> = []

  for (const part of wireParts) {
    if (part.type === "image" && part.base64 && part.mediaType) {
      images.push({ base64: part.base64, mediaType: part.mediaType })
    } else if (part.type === "file" && part.url && part.name) {
      files.push({ path: part.url, name: part.name, mimeType: part.mimeType })
    }
  }

  return {
    ...(images.length ? { images } : {}),
    ...(files.length ? { files } : {}),
  }
}

/** Convert runtime MessagePart[] to bridle wire parts */
function messagePartsToWireParts(parts: MessagePart[]): WirePart[] {
  return parts.map(part => {
    switch (part.type) {
      case MessagePartTypes.Text:
        return { type: "text" as const, text: part.text }
      case MessagePartTypes.Image:
        return { type: "image" as const, base64: part.base64, mediaType: part.mediaType }
      case MessagePartTypes.File:
        return { type: "file" as const, url: part.path, name: part.name, mimeType: part.mimeType }
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
    console.log("[bridle] channel stopped")
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
      console.warn("[bridle] streamSend: socket not connected, falling back to non-streaming")
      await streamer(() => {})
      return
    }

    console.log(`[bridle] stream start (clientId=${to} messageId=${messageId.slice(0, 8)})`)
    this.socket.emit("typing", { clientId: to, ts: Date.now() })

    let lastSent = ""
    let pendingText = ""
    let sending = false
    let chunksEmitted = 0

    const flush = () => {
      if (sending || pendingText === lastSent) return
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
      this.socket?.emit("stream_end", {
        clientId: to,
        text: finalText,
        parts: [{ type: "text", text: finalText }],
        messageId,
        ts: Date.now(),
      })
      console.log(
        `[bridle] stream end (messageId=${messageId.slice(0, 8)}, ` +
        `chunks=${chunksEmitted}, length=${finalText.length})`,
      )
    }
  }

  private connect(): void {
    const url = this.apiUrl
    console.log(`[bridle] connecting to hub at ${url}`)

    this.socket = io(url, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity,
      auth: {
        apiKey: process.env.BRIDLE_API_KEY ?? "",
        agentId: process.env.BRIDLE_AGENT_ID ?? "",
      },
    })

    this.socket.on("connect", () => {
      console.log("[bridle] connected to hub")
      this.socket?.emit("register", {})
    })

    this.socket.on("disconnect", (reason) => {
      console.log(`[bridle] disconnected from hub: ${reason}`)
    })

    this.socket.on("reconnect", () => {
      console.log("[bridle] reconnected to hub")
      this.socket?.emit("register", {})
    })

    this.socket.on("message", (data: unknown) => {
      const msg = data as Record<string, unknown>
      if (!msg?.clientId || !this.handler) return

      const text = (msg.text as string) ?? ""
      const wireParts = (msg.parts as WirePart[]) ?? []
      const { images, files } = extractMediaFromWireParts(wireParts)

      this.handler(buildMessage({
        id: (msg.messageId as string) ?? randomUUID(),
        text,
        from: msg.clientId as string,
        channel: "bridle",
        ts: Date.now(),
        ...(images ? { images } : {}),
        ...(files ? { files } : {}),
        metadata: { clientId: msg.clientId, source: "bridle" },
      })).catch(err => console.error("[bridle] handler error:", err))
    })

    this.socket.on("debug_set", (data: unknown) => {
      const msg = data as { enabled?: boolean }
      const next = !!msg?.enabled
      if (this.debugEnabled !== next) {
        console.log(`[bridle] debug ${next ? "enabled" : "disabled"} by hub`)
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
      console.error("[bridle] connection error:", err.message)
    })
  }
}
