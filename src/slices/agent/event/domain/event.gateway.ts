import type { Event } from "./event.types"

export interface IEventGateway {
  append(sessionId: string, event: Event): Promise<void>
  read(sessionId: string): Promise<Event[]>
}
