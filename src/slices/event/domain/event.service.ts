import type { EventGateway } from "./event.gateway"
import type { Event } from "./event.types"

export class EventService {
  constructor(private gateway: EventGateway) {}

  async append(sessionId: string, event: Event): Promise<void> {
    return this.gateway.append(sessionId, event)
  }

  async read(sessionId: string): Promise<Event[]> {
    return this.gateway.read(sessionId)
  }
}
