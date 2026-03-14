import type { Event } from "./event.types"

export interface EventGateway {
  append(sessionId: string, event: Event): Promise<void>
  read(sessionId: string): Promise<Event[]>
}
