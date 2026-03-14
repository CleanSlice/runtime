import type { Event } from "../event"
import type { ILlmGateway } from "../llm/domain/llm.gateway"
import { SessionGateway } from "./data/session.gateway"
import { SessionService } from "./domain/session.service"
import { randomUUID } from "crypto"

const COMPACTION_THRESHOLD = 50
const RECENT_KEEP = 10

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

  async compact(sessionId: string, llm: ILlmGateway): Promise<void> {
    const events = await this.service.read(sessionId)
    if (events.length <= COMPACTION_THRESHOLD) return

    const toSummarize = events.slice(0, events.length - RECENT_KEEP)
    const recent = events.slice(events.length - RECENT_KEEP)

    const response = await llm.complete(
      "Summarize this conversation history in 200 words",
      toSummarize,
      []
    )

    const summaryEvent: Event = {
      id: randomUUID(),
      type: "summary",
      ts: Date.now(),
      data: { text: response.text },
    }

    await this.service.rewrite(sessionId, [summaryEvent, ...recent])
  }
}
