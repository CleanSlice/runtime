import type { Event } from "../../../setup/event"
import type { ILlmGateway } from "../../../setup/llm/domain/llm.gateway"
import type { SessionService } from "./session.service"
import { randomUUID } from "crypto"
import { createLogger } from "../../../setup/logger"
import { capPayload, fitEventsToBudget } from "./contextBudget"

const log = createLogger("session")

// Long stdout/CDN URLs/bash scripts inside tool_* events drown the summarizer
// in noise. Trim leaf strings to this many chars in the COPY sent for
// summarization; the on-disk events remain untouched.
const SUMMARY_FIELD_MAX_CHARS = 500
// …and one event to this much in total, however many strings it holds
// (CLEAN-124): a catalogue of a thousand short entries is noise too.
const SUMMARY_EVENT_MAX_CHARS = 4_000
/**
 * The most the archivist is handed in one call. Compaction needs the model;
 * a session the model already refused as too long must still shrink, so
 * the oldest of the old slice is left out rather than nothing archived.
 */
export const SUMMARY_INPUT_MAX_CHARS = 300_000

export function truncateStrings(value: unknown, max: number, depth = 0): unknown {
  if (depth > 5) return value
  if (typeof value === "string") {
    if (value.length <= max) return value
    return value.slice(0, max) + `…[truncated +${value.length - max} chars]`
  }
  if (Array.isArray(value)) {
    return value.map(v => truncateStrings(v, max, depth + 1))
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateStrings(v, max, depth + 1)
    }
    return out
  }
  return value
}

export function trimForSummary(event: Event): Event {
  if (event.type !== "tool_call" && event.type !== "tool_result") return event
  return {
    ...event,
    data: capPayload(truncateStrings(event.data, SUMMARY_FIELD_MAX_CHARS), SUMMARY_EVENT_MAX_CHARS),
  }
}

// Approximate the on-the-wire size of a session. JSON length ≈ bytes for the
// ASCII-heavy payloads we store; good enough to decide whether to compact.
export function estimateEventsBytes(events: Event[]): number {
  return JSON.stringify(events).length
}

export class CompactionService {
  private compacting = new Set<string>()

  constructor(
    private sessionService: SessionService,
    private compactionThreshold: number,
    private recentKeep: number,
    private compactionBytesThreshold: number,
  ) {}

  /** Update the thresholds used by future compact() calls. */
  updateConfig(compactionThreshold: number, recentKeep: number, compactionBytesThreshold: number): void {
    this.compactionThreshold = compactionThreshold
    this.recentKeep = recentKeep
    this.compactionBytesThreshold = compactionBytesThreshold
  }

  async compact(sessionId: string, llm: ILlmGateway): Promise<void> {
    if (this.compacting.has(sessionId)) {
      log.info(`skipping compaction for ${sessionId}: already in progress`)
      return
    }

    const events = await this.sessionService.read(sessionId)
    const bytes = estimateEventsBytes(events)
    const overCount = events.length > this.compactionThreshold
    const overBytes = bytes > this.compactionBytesThreshold
    // Only the OLD slice (everything before recentKeep) can be summarized away.
    // If there aren't enough events to keep + summarize, compaction is a no-op.
    if (!overCount && !overBytes) return
    if (events.length <= this.recentKeep) return

    const reason = overBytes ? `${Math.round(bytes / 1024)}KB > ${Math.round(this.compactionBytesThreshold / 1024)}KB` : `${events.length} events`
    log.info(`compacting ${sessionId} (${reason}): ${events.length} → ${this.recentKeep} events`)
    this.compacting.add(sessionId)
    try {
      const snapshotLen = events.length
      const oldSlice = events.slice(0, snapshotLen - this.recentKeep).map(trimForSummary)
      const fitted = fitEventsToBudget(oldSlice, SUMMARY_INPUT_MAX_CHARS)
      if (fitted.dropped > 0) {
        log.warn(`compacting ${sessionId}: ${fitted.dropped} oldest events left out of the archive to fit the model`)
      }
      const toSummarize = fitted.events
      const recent = events.slice(snapshotLen - this.recentKeep)

      const response = await llm.complete(
        `You are a conversation archivist. Summarize this conversation history in two parts:

PART 1 — KEY VALUES (mandatory, do not skip):
Extract and list EVERY specific value from the conversation. Missing even one value means the archive is broken. Pay special attention to tool_result outputs — these carry the only persistent state (IDs, hashes, URLs returned by APIs, error messages that define what to try next). Extract:
- Email addresses (both sender and recipient)
- Passwords, tokens, API keys (write "saved as secret_key" — do not repeat the actual value)
- URLs, file paths, hostnames
- IDs of every kind: record IDs, campaign IDs, ad IDs, page IDs, message IDs, image hashes, content hashes, fingerprints
- Numbers, dates, amounts, budgets, file sizes
- Error messages and error codes from tool_results (verbatim — these tell the next turn what failed and why)
- Tool call parameters: exact arguments passed to exec, secret_set, cron_add, etc.
- Names of people, services, accounts
Format: "- <label>: <value>"

PART 2 — NARRATIVE SUMMARY:
Write in THIRD PERSON: "The user asked about X. The assistant did Y."
Include what actions were performed and their results. Max 200 words.

NOTE: Long string fields inside tool_call and tool_result events have been truncated to the first ${SUMMARY_FIELD_MAX_CHARS} chars (marker: "…[truncated +N chars]"). The headline result or first error usually fits in that window — extract it carefully.

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
      log.info(`compaction done: ${sessionId}${newlyAppended.length > 0 ? ` (+${newlyAppended.length} appended during compaction)` : ""}`)
    } finally {
      this.compacting.delete(sessionId)
    }
  }

  compactAsync(sessionId: string, llm: ILlmGateway): void {
    this.compact(sessionId, llm).catch(err => {
      log.error(`compaction failed for ${sessionId}`, err)
    })
  }
}
