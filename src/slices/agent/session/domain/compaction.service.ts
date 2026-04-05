import type { Event } from "../../../setup/event"
import type { ILlmGateway } from "../../../setup/llm/domain/llm.gateway"
import type { SessionService } from "./session.service"
import { randomUUID } from "crypto"

export class CompactionService {
  private compacting = new Set<string>()

  constructor(
    private sessionService: SessionService,
    private compactionThreshold: number,
    private recentKeep: number,
  ) {}

  async compact(sessionId: string, llm: ILlmGateway): Promise<void> {
    if (this.compacting.has(sessionId)) {
      console.log(`[session] skipping compaction for ${sessionId}: already in progress`)
      return
    }

    const events = await this.sessionService.read(sessionId)
    if (events.length <= this.compactionThreshold) return

    console.log(`[session] compacting ${sessionId}: ${events.length} → ${this.recentKeep} events`)
    this.compacting.add(sessionId)
    try {
      const snapshotLen = events.length
      const toSummarize = events.slice(0, snapshotLen - this.recentKeep)
      const recent = events.slice(snapshotLen - this.recentKeep)

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

      const currentEvents = await this.sessionService.read(sessionId)
      const newlyAppended = currentEvents.slice(snapshotLen)

      const summaryEvent: Event = {
        id: randomUUID(),
        type: "summary",
        ts: Date.now(),
        data: { text: `[ARCHIVED CONTEXT — search here when user says "I sent you earlier" / "see above"]\n${response.text}\n[END ARCHIVED CONTEXT]` },
      }

      await this.sessionService.rewrite(sessionId, [summaryEvent, ...recent, ...newlyAppended])
      console.log(`[session] compaction done: ${sessionId}${newlyAppended.length > 0 ? ` (+${newlyAppended.length} appended during compaction)` : ""}`)
    } finally {
      this.compacting.delete(sessionId)
    }
  }

  compactAsync(sessionId: string, llm: ILlmGateway): void {
    this.compact(sessionId, llm).catch(err => {
      console.error(`[session] compaction failed for ${sessionId}:`, err)
    })
  }
}
