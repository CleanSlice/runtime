import type { Event } from "../../event/event.module"

export interface ISessionGateway {
  append(sessionId: string, event: Event): Promise<void>
  read(sessionId: string): Promise<Event[]>
}
