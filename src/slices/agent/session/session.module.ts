import type { Event } from "../event"
import type { ILlmGateway } from "../../setup/llm/domain/llm.gateway"
import { SessionGateway } from "./data/session.gateway"
import { SessionService } from "./domain/session.service"
import { randomUUID } from "crypto"

export interface SessionConfig {
  compactionThreshold?: number
  recentKeep?: number
}

export class SessionModule {
  private service: SessionService
  private compactionThreshold: number
  private recentKeep: number
  // Sessions currently undergoing compaction. Prevents concurrent compact() calls
  // from racing to rewrite the same file and overwriting each other's output.
  private compacting = new Set<string>()

  constructor(agentDir: string, config?: SessionConfig) {
    this.service = new SessionService(new SessionGateway(agentDir))
    this.compactionThreshold = config?.compactionThreshold ?? 60
    this.recentKeep = config?.recentKeep ?? 20
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

  clear(channelId: string, userId: string): void {
    this.service.clear(channelId, userId)
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
    // Guard: skip if another compaction is already in progress for this session.
    // Two concurrent compact() calls would both read the same snapshot, produce
    // independent summaries, and the second rewrite would overwrite the first.
    if (this.compacting.has(sessionId)) {
      console.log(`[session] skipping compaction for ${sessionId}: already in progress`)
      return
    }

    const events = await this.service.read(sessionId)
    if (events.length <= this.compactionThreshold) return

    console.log(`[session] compacting ${sessionId}: ${events.length} → ${this.recentKeep} events`)
    this.compacting.add(sessionId)
    try {
      const snapshotLen = events.length
      const toSummarize = events.slice(0, snapshotLen - this.recentKeep)
      const recent = events.slice(snapshotLen - this.recentKeep)

      // LLM call can take seconds. While it runs, other tasks may append events.
      const response = await llm.complete(
        `You are a conversation archivist. Summarize this conversation history in two parts:

PART 1 — KEY VALUES (mandatory, do not skip):
Extract and list EVERY specific value from the conversation. Missing even one value means the archive is broken. Include:
- Email addresses (both sender and recipient)
- Passwords, tokens, API keys (write "saved as secret_key" — do not repeat the actual value)
- URLs, file paths, hostnames
- IDs, numbers, dates, amounts
- Tool call parameters: exact arguments passed to exec, secret_set, cron_add, etc.
- Names of people, services, accounts
Format: "- <label>: <value>"

PART 2 — NARRATIVE SUMMARY:
Write in THIRD PERSON: "The user asked about X. The assistant did Y."
Include what actions were performed and their results. Max 150 words.

This archive replaces the original messages. If a value is not here, it is lost forever.`,
        toSummarize,
        []
      )

      // Re-read to capture events appended during the LLM call. Any event
      // beyond snapshotLen was written after our initial read and must be
      // preserved — they would be silently lost if we rewrote only `recent`.
      const currentEvents = await this.service.read(sessionId)
      const newlyAppended = currentEvents.slice(snapshotLen)

      const summaryEvent: Event = {
        id: randomUUID(),
        type: "summary",
        ts: Date.now(),
        data: { text: `[ARCHIVED CONTEXT — search here when user says "я кидал выше" / "I sent you earlier"]\n${response.text}\n[END ARCHIVED CONTEXT]` },
      }

      await this.service.rewrite(sessionId, [summaryEvent, ...recent, ...newlyAppended])
      console.log(`[session] compaction done: ${sessionId}${newlyAppended.length > 0 ? ` (+${newlyAppended.length} appended during compaction)` : ""}`)
    } finally {
      this.compacting.delete(sessionId)
    }
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
