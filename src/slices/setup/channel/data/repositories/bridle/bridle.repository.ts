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

/**
 * Bridle channel — agent connects TO the Bridle hub (NestJS API) as a socket.io client.
 * The hub relays messages between browser users and this agent.
 *
 * Flow:  Browser ↔ /ws/chat ↔ Bridle Hub ↔ /ws/agent ↔ Agent (this)
 *
 * Auth: BRIDLE_API_KEY + BRIDLE_BOT_ID in Socket.IO handshake.
 *
 * Wire protocol carries `parts: BridlePart[]` for rich content (text, images, files).
 */
export class BridleRepository implements IChannelGateway {
  readonly name = "bridle"

  private handler?: (msg: Message) => Promise<void>
  private socket: Socket | null = null
  private apiUrl: string

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl
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

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.handler = handler
  }

  async streamSend(to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void> {
    const messageId = randomUUID()

    if (!this.socket?.connected) {
      await streamer(() => {})
      return
    }

    this.socket.emit("typing", { clientId: to, ts: Date.now() })

    let lastSent = ""
    let pendingText = ""
    let sending = false

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
        botId: process.env.BRIDLE_BOT_ID ?? "",
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

    this.socket.on("connect_error", (err) => {
      console.error("[bridle] connection error:", err.message)
    })
  }
}
