import type { Message } from "../../../domain/channel.types"
import { randomUUID } from "crypto"

export class SlackRepository {
  private ws: WebSocket | null = null
  private handler?: (msg: Message) => Promise<void>

  constructor(
    private botToken: string,
    private appToken: string,
  ) {}

  onMessage(handler: (msg: Message) => Promise<void>): void {
    this.handler = handler
  }

  async start(): Promise<void> {
    const res = await fetch("https://slack.com/api/apps.connections.open", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.appToken}`, "Content-Type": "application/json" },
    })
    const json = (await res.json()) as { ok: boolean; url: string }
    if (!json.ok) throw new Error("[slack] Failed to open connection")

    this.ws = new WebSocket(json.url)

    this.ws.onopen = () => console.log("[slack] Socket Mode connected")

    this.ws.onmessage = async (event: MessageEvent) => {
      let payload: Record<string, unknown>
      try {
        payload = JSON.parse(event.data as string)
      } catch {
        return
      }

      // Acknowledge every envelope
      if (payload.envelope_id) {
        this.ws?.send(JSON.stringify({ type: "ack", envelope_id: payload.envelope_id }))
      }

      if (payload.type === "events_api") {
        const ev = payload as {
          envelope_id: string
          payload: {
            event: { type: string; text: string; user: string; channel: string; ts: string }
          }
        }
        const event = ev.payload.event
        if (event.type === "message" && this.handler) {
          const handler = this.handler
          // Non-blocking — handle in parallel
          ;(async () => {
            await handler({
              id: randomUUID(),
              text: event.text,
              from: event.user,
              channel: "slack",
              ts: Date.now(),
              sessionId: "",
              metadata: { channel: event.channel, ts: event.ts },
            })
          })().catch(err => console.error("[slack] message handler error:", err))
        }
      }
    }

    this.ws.onerror = (err: Event) => console.error("[slack] WebSocket error", err)
    this.ws.onclose = () => console.log("[slack] WebSocket closed")
  }

  stop(): Promise<void> {
    this.ws?.close()
    this.ws = null
    return Promise.resolve()
  }

  async send(chatId: string, text: string): Promise<void> {
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: chatId, text }),
    })
  }
}
