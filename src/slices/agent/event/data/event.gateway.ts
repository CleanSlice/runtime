import type { IEventGateway } from "../domain/event.gateway"
import type { Event } from "../domain/event.types"

export class EventGateway implements IEventGateway {
  private store: Map<string, Event[]> = new Map()

  async append(sessionId: string, event: Event): Promise<void> {
    const events = this.store.get(sessionId) ?? []
    events.push(event)
    this.store.set(sessionId, events)
  }

  async read(sessionId: string): Promise<Event[]> {
    return this.store.get(sessionId) ?? []
  }
}
