import type { IChannelGateway } from "../../../domain/channel.gateway"
import type { Message } from "../../../domain/channel.types"
import { randomUUID } from "crypto"
import { io, type Socket } from "socket.io-client"

/**
 * Web channel — agent connects TO the NestJS API as a socket.io client.
 * The API is the hub between browser users and the agent.
 *
 * Flow:  Browser ↔ socket.io /ws/chat ↔ NestJS API ↔ socket.io /ws/agent ↔ Agent (this)
 *
 * Events (API → Agent):
 *   "message"  { clientId, text, messageId, images? }
 *   "pong"     {}
 *
 * Events (Agent → API):
 *   "register"     {}
 *   "message"      { clientId, text, messageId, ts }
 *   "stream"       { clientId, text, messageId, ts }
 *   "stream_end"   { clientId, text, messageId, ts }
 *   "typing"       { clientId, ts }
 *   "ping"         {}
 */
export class WebRepository implements IChannelGateway {
  readonly name = "web"

  private handler?: (msg: Message) => Promise<void>
  private socket: Socket | null = null
  private apiUrl: string

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl
  }

  // ── IChannelGateway implementation ──────────────────────────

  async start(): Promise<void> {
    this.connect()
  }

  async stop(): Promise<void> {
    this.socket?.disconnect()
    this.socket = null
    console.log("[web] channel stopped")
  }

  async send(to: string, text: string): Promise<void> {
    this.socket?.emit("message", {
      clientId: to,
      text,
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
      this.socket?.emit("stream", { clientId: to, text: toSend, messageId, ts: Date.now() })
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
      this.socket?.emit("stream_end", { clientId: to, text: finalText, messageId, ts: Date.now() })
    }
  }

  // ── Socket.io client ───────────────────────────────────────

  private connect(): void {
    const url = this.apiUrl
    console.log(`[web] connecting to API at ${url}/ws/agent`)

    this.socket = io(`${url}/ws/agent`, {
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 3000,
      reconnectionAttempts: Infinity,
    })

    this.socket.on("connect", () => {
      console.log("[web] connected to API")
      this.socket?.emit("register", {})
    })

    this.socket.on("disconnect", (reason) => {
      console.log(`[web] disconnected from API: ${reason}`)
    })

    this.socket.on("reconnect", () => {
      console.log("[web] reconnected to API")
      this.socket?.emit("register", {})
    })

    // Incoming messages from browser clients (routed via API hub)
    this.socket.on("message", (data: any) => {
      if (!data?.text || !data?.clientId || !this.handler) return

      const images = Array.isArray(data.images)
        ? data.images.filter((img: any) => img.base64 && img.mediaType)
        : undefined

      this.handler({
        id: data.messageId ?? randomUUID(),
        text: data.text,
        from: data.clientId,
        channel: "web",
        ts: Date.now(),
        sessionId: "",
        ...(images?.length ? { images } : {}),
        metadata: { clientId: data.clientId, source: "web" },
      }).catch(err => console.error("[web] handler error:", err))
    })

    this.socket.on("connect_error", (err) => {
      console.error("[web] connection error:", err.message)
    })
  }
}
