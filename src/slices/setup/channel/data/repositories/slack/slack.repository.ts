import { buildMessage, type IChannelGroup, type Message } from "../../../domain/channel.types"
import { randomUUID } from "crypto"
import { createLogger } from "../../../../logger"

const log = createLogger("slack")

interface ISlackConversation {
  id: string
  name?: string
  is_private?: boolean
  is_im?: boolean
  is_mpim?: boolean
}

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

    this.ws.onopen = () => log.info("Socket Mode connected")

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
            await handler(buildMessage({
              id: randomUUID(),
              text: event.text,
              from: event.user,
              channel: "slack",
              ts: Date.now(),
              metadata: { channel: event.channel, ts: event.ts },
            }))
          })().catch(err => log.error("message handler error", err))
        }
      }
    }

    this.ws.onerror = (err: Event) => log.error("WebSocket error", err)
    this.ws.onclose = () => log.info("WebSocket closed")
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

  /**
   * Channels the bot is a member of — unlike Telegram, Slack's API can
   * answer this directly (users.conversations for the calling bot user),
   * so there's no persisted registry; every call is a live query.
   */
  async listGroups(): Promise<IChannelGroup[]> {
    const out: IChannelGroup[] = []
    let cursor = ""
    // Cursor pagination, hard-capped to keep a huge workspace from stalling the tool.
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: "200",
      })
      if (cursor) params.set("cursor", cursor)
      const res = await fetch(`https://slack.com/api/users.conversations?${params}`, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      })
      const json = (await res.json()) as {
        ok: boolean
        error?: string
        channels?: ISlackConversation[]
        response_metadata?: { next_cursor?: string }
      }
      if (!json.ok) {
        log.error(`users.conversations failed: ${json.error}`)
        break
      }
      for (const ch of json.channels ?? []) {
        out.push({
          id: ch.id,
          name: ch.name,
          type: ch.is_private ? "private_channel" : "public_channel",
        })
      }
      cursor = json.response_metadata?.next_cursor ?? ""
      if (!cursor) break
    }
    return out
  }
}
