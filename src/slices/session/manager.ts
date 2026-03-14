import type { Session } from "./domain/Session"

export class SessionManager {
  private sessions: Map<string, Session> = new Map()

  getSessionId(channelId: string, userId: string): string {
    return `${channelId}:${userId}`
  }

  getOrCreate(channelId: string, userId: string): Session {
    const id = this.getSessionId(channelId, userId)
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
}
