import type { Event } from "../../../shared/types/Event"

export interface SessionGateway {
  append(sessionId: string, event: Event): Promise<void>
  read(sessionId: string): Promise<Event[]>
}
