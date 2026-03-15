import type { Event } from "../event"
import type { ILlmGateway } from "../llm/domain/llm.gateway"
import { SessionGateway } from "./data/session.gateway"
import { SessionService } from "./domain/session.service"
import { randomUUID } from "crypto"

const COMPACTION_THRESHOLD = 60
const RECENT_KEEP = 20

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
      `You are a conversation archivist. Summarize this conversation history in two parts:

PART 1 — KEY VALUES (mandatory, do not skip):
List ALL specific values mentioned: tokens, API keys, URLs, IDs, file paths, env var names, passwords, emails, numbers, hostnames, app names. Format as:
- <name>: <value>

PART 2 — NARRATIVE SUMMARY:
Write in THIRD PERSON: "The user asked about X. The assistant did Y."
Do NOT write in first person. Be concise. Max 150 words.

This archived context will be injected into future conversations — the assistant MUST be able to find any value the user refers to as "I sent you earlier" or "я кидал выше".`,
      toSummarize,
      []
    )

    const summaryEvent: Event = {
      id: randomUUID(),
      type: "summary",
      ts: Date.now(),
      data: { text: `[ARCHIVED CONTEXT — search here when user says "я кидал выше" / "I sent you earlier"]\n${response.text}\n[END ARCHIVED CONTEXT]` },
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
