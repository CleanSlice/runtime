import type { Event } from "../../../setup/event"

export interface ISessionGateway {
  append(sessionId: string, event: Event): Promise<void>
  read(sessionId: string): Promise<Event[]>
  rewrite(sessionId: string, events: Event[]): Promise<void>
  clear?(sessionId: string): void
}

/**
 * Lazy restore hook: a transcript may still be downloading from remote storage
 * when the agent boots. ensure() makes it local before it is read or written;
 * discard() drops a not-yet-downloaded one that is being deleted.
 * Paths are relative to the agent dir.
 */
export interface ISessionHydrator {
  ensure(relPath: string): Promise<void>
  discard(relPath: string): void
}
