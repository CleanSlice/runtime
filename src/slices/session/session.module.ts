import type { Event } from "../event"
import type { ILlmGateway } from "../llm/domain/llm.gateway"
import { SessionGateway } from "./data/session.gateway"
import { SessionService } from "./domain/session.service"
import { randomUUID } from "crypto"

const COMPACTION_THRESHOLD = 30
const RECENT_KEEP = 15

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

  /**
   * Read events visible to a specific task:
   * - shared events (taskId undefined)
   * - events belonging to this task (taskId === taskId)
   */
  async readForTask(sessionId: string, taskId: string): Promise<Event[]> {
    const all = await this.service.read(sessionId)
    return all.filter(e => !e.taskId || e.taskId === taskId)
  }

  async compact(sessionId: string, llm: ILlmGateway): Promise<void> {
    const events = await this.service.read(sessionId)
    if (events.length <= COMPACTION_THRESHOLD) return

    console.log(`[session] compacting ${sessionId}: ${events.length} → ${RECENT_KEEP} events`)

    const toSummarize = events.slice(0, events.length - RECENT_KEEP)
    const recent = events.slice(events.length - RECENT_KEEP)

    const response = await llm.complete(
      "You are a memory summarizer. Summarize the following conversation history concisely in 150-200 words. Preserve key facts, decisions, and context that would be useful for future responses. Be specific, not vague.",
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
    console.log(`[session] compaction done: ${sessionId}`)
  }

  /**
   * Fire-and-forget compaction — runs async after response, does not block.
   */
  compactAsync(sessionId: string, llm: ILlmGateway): void {
    this.compact(sessionId, llm).catch(err => {
      console.error(`[session] compaction failed for ${sessionId}:`, err)
    })
  }
}
