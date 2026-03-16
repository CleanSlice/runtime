import type { ISessionGateway } from "./session.gateway"
import type { Session } from "./session.types"
import type { Event } from "../../event"

export class SessionService {
  private sessions: Map<string, Session> = new Map()

  constructor(private gateway: ISessionGateway) {}

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
    return this.gateway.append(sessionId, event)
  }

  async read(sessionId: string): Promise<Event[]> {
    return this.gateway.read(sessionId)
  }

  async rewrite(sessionId: string, events: Event[]): Promise<void> {
    return this.gateway.rewrite(sessionId, events)
  }
}
