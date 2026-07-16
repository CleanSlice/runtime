import type { ISessionGateway } from "./session.gateway"
import type { Session } from "./session.types"
import type { Event } from "../../../setup/event"
import type { IActivityReporter } from "./activity"

const PREVIEW_MAX = 200

export class SessionService {
  private sessions: Map<string, Session> = new Map()
  private reporter?: IActivityReporter

  constructor(private gateway: ISessionGateway) {}

  /** Wire a transport for live session-activity signals (see IActivityReporter). */
  setActivityReporter(reporter: IActivityReporter): void {
    this.reporter = reporter
  }

  getOrCreate(channelId: string, userId: string): Session {
    const id = `${channelId}:${userId}`
    if (this.sessions.has(id)) return this.sessions.get(id)!

    const session: Session = {
      id,
      channelId,
      userId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.sessions.set(id, session)
    return session
  }

  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session) session.updatedAt = Date.now()
  }

  clear(channelId: string, userId: string): void {
    const id = `${channelId}:${userId}`
    // Remove in-memory session so next getOrCreate gives a fresh one
    this.sessions.delete(id)
    // Also clear persisted events for this session
    this.gateway.clear?.(id)
  }

  async append(sessionId: string, event: Event): Promise<void> {
    await this.gateway.append(sessionId, event)
    this.emitActivity(sessionId, event)
  }

  // Fire a live activity signal for real user/assistant turns only. Skips
  // internal sessions (cron/heartbeat) and synthetic loop-control events
  // (continuation prompts + partial chunks tagged `data.transient`).
  private emitActivity(sessionId: string, event: Event): void {
    if (!this.reporter) return
    if (event.type !== "user" && event.type !== "assistant") return
    const colon = sessionId.indexOf(":")
    const channel = colon >= 0 ? sessionId.slice(0, colon) : sessionId
    if (channel === "internal") return
    const data = event.data as { text?: string; transient?: boolean } | undefined
    if (data?.transient === true) return
    const text = typeof data?.text === "string" ? data.text : ""
    try {
      this.reporter.report({
        sessionKey: sessionId,
        channel,
        externalUserId: colon >= 0 ? sessionId.slice(colon + 1) : "",
        eventId: event.id,
        role: event.type,
        ts: event.ts,
        preview: text.slice(0, PREVIEW_MAX),
      })
    } catch {
      // Activity is best-effort telemetry — never let it break persistence.
    }
  }

  async read(sessionId: string): Promise<Event[]> {
    return this.gateway.read(sessionId)
  }

  async rewrite(sessionId: string, events: Event[]): Promise<void> {
    return this.gateway.rewrite(sessionId, events)
  }
}
