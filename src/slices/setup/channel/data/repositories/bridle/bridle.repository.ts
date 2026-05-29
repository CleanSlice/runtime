import type { IChannelGateway } from "../../../domain/channel.gateway"
import {
  MessagePartTypes,
  buildMessage,
  buildUiForm,
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
   * Opt-in: when true, /form intent + matching ui_submit are handled
   * inside the channel before the agent's onMessage handler runs.
   * Toggled by `attachFormDemo()` or `BRIDLE_FORM_DEMO=true` env.
   */
  private formDemoEnabled = false
  /**
   * Server-pushed debug flag. Updated via "debug_set" WS event from the
   * hub. Defaults to false so a fresh agent doesn't leak prompts before
   * the hub has had a chance to rehydrate the value from DB.
   */
  private debugEnabled = false

  constructor(apiUrl: string) {
    this.apiUrl = apiUrl
    // Auto-enable from env so showcase deployments can flip it on without
    // a code change: `BRIDLE_FORM_DEMO=true` in the agent's env.
    if (process.env.BRIDLE_FORM_DEMO === "true") {
      this.formDemoEnabled = true
      log.info("form demo enabled via BRIDLE_FORM_DEMO=true")
    }
  }

  /**
   * Opt-in showcase: wires the /form trigger and the matching ui_submit
   * ack into this channel. Equivalent to setting `BRIDLE_FORM_DEMO=true`
   * in env. Idempotent — calling more than once is a no-op.
   *
   * The handler runs BEFORE your agent's onMessage:
   *   - If the incoming text is `/form` and the client advertises the
   *     `ui` capability, sends a plan-picker form and short-circuits.
   *   - If the incoming message carries a `ui_submit` with
   *     `uiId === 'plan-demo'`, acks it with a confirmation and
   *     short-circuits.
   *   - Everything else falls through to your agent untouched.
   *
   * On channels that don't advertise the `ui` capability the /form
   * branch sends a plain-text fallback and still short-circuits, so
   * the agent doesn't have to know about the showcase.
   */
  attachFormDemo(): void {
    if (this.formDemoEnabled) return
    this.formDemoEnabled = true
    log.info("form demo attached via attachFormDemo()")
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

      const text = (msg.text as string) ?? ""
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

      // Showcase short-circuit. Runs only when the channel was put in
      // demo mode (env or attachFormDemo()). Falls through to the agent's
      // handler if nothing matches.
      if (this.formDemoEnabled) {
        const handled = this.tryHandleFormDemo(
          msg.clientId as string,
          text,
          parts,
          capabilities,
        )
        if (handled) return
      }

      this.handler(buildMessage({
        id: (msg.messageId as string) ?? randomUUID(),
        text,
        from: msg.clientId as string,
        channel: "bridle",
        ts: Date.now(),
        parts,
        ...(capabilities ? { capabilities } : {}),
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

  /**
   * Form-demo intercept. Returns true when the incoming message was the
   * showcase trigger (`/form`) or its ui_submit ack, so the caller knows
   * to skip the agent's main handler. Returns false otherwise.
   *
   * Kept in the channel layer on purpose — the agent never has to know
   * the showcase exists; flip BRIDLE_FORM_DEMO and it Just Works.
   */
  private tryHandleFormDemo(
    clientId: string,
    text: string,
    parts: MessagePart[],
    capabilities: string[] | undefined,
  ): boolean {
    // 1) ui_submit ack — checks before text trigger because submit messages
    //    carry no text, just the structured part.
    for (const part of parts) {
      if (part.type !== MessagePartTypes.UiSubmit) continue
      if (part.uiId !== "plan-demo") continue
      const values = part.values as Record<string, unknown>
      const plan = String(values.plan ?? "unknown")
      const newsletter = values.newsletter === true
      this.send(
        clientId,
        `Got it — you picked **${plan}**${newsletter ? ", newsletter on" : ""}. ` +
          `(This is a demo; nothing actually changed.)`,
      ).catch(err => log.error("form demo ack failed", err))
      return true
    }

    // 2) /form trigger — case-insensitive, ignores surrounding whitespace
    if (text?.trim().toLowerCase() !== "/form") return false

    // 3) Capability gate — degrade to text for channels without ui support
    if (!capabilities?.includes("ui")) {
      this.send(
        clientId,
        "Reply with one of: `basic`, `pro`, `team` (your client doesn't support inline forms).",
      ).catch(err => log.error("form demo fallback failed", err))
      return true
    }

    const form = buildUiForm(
      [
        { type: "heading", text: "Pick a plan" },
        { type: "text", text: "You can change this later in account settings." },
        {
          type: "radio",
          name: "plan",
          label: "Plan",
          required: true,
          default: "basic",
          options: [
            { value: "basic", label: "Basic — $0 / mo" },
            { value: "pro", label: "Pro — $10 / mo" },
            { value: "team", label: "Team — $30 / mo" },
          ],
        },
        {
          type: "checkbox",
          name: "newsletter",
          label: "Send me weekly product updates",
        },
      ],
      { uiId: "plan-demo", submitLabel: "Continue" },
    )

    this.send(clientId, "Pick a plan to continue:", [
      { type: MessagePartTypes.Text, text: "Pick a plan to continue:" },
      form,
    ]).catch(err => log.error("form demo send failed", err))
    return true
  }
}
