import type { Event } from "../../event"

export interface ISessionGateway {
  append(sessionId: string, event: Event): Promise<void>
  read(sessionId: string): Promise<Event[]>
}
