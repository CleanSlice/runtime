import type { Event } from "../event"
import { SessionGateway } from "./data/session.gateway"
import { SessionService } from "./domain/session.service"

export class SessionModule {
  private service: SessionService

  constructor(agentDir: string) {
    this.service = new SessionService(new SessionGateway(agentDir))
  }

  getOrCreate(channelId: string, userId: string) {
    return this.service.getOrCreate(channelId, userId)
  }

  touch(sessionId: string): void {
    this.service.touch(sessionId)
  }

  async append(sessionId: string, event: Event): Promise<void> {
    await this.service.append(sessionId, event)
  }

  async read(sessionId: string): Promise<Event[]> {
    return this.service.read(sessionId)
  }
}
