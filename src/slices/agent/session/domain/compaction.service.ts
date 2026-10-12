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

/** Why a compaction ran (CLEAN-150 US4). Recorded on the summary event. */
export type CompactionReason = "boundary" | "idle" | "hard-limit" | "operator"

/** What was going on when the archive was written, so the next phase can pick up. */
export interface IInFlightNote {
  goal: string
  done: string[]
  pending: string[]
}

export interface ICompactOptions {
  reason?: CompactionReason
  /** A task of this session is still running: wait for the boundary unless the hard limit is passed. */
  inFlight?: boolean
  /** Operator request: ignore the thresholds (the recentKeep floor still holds). */
  force?: boolean
  /** Work the caller knows is still owed (inbox items) — goes into the in-flight note. */
  pending?: string[]
}

export interface ICompactionLimits {
  /** The model's history budget; the hard limit is a percentage of it. */
  contextBudgetChars: number
  /** Past this percentage of the budget, a running task no longer defers compaction. */
  hardLimitPct: number
}

const DEFAULT_LIMITS: ICompactionLimits = { contextBudgetChars: 400_000, hardLimitPct: 90 }

export class CompactionService {
  private compacting = new Set<string>()
  private last = new Map<string, { reason: CompactionReason; ts: number }>()

  constructor(
    private sessionService: SessionService,
    private compactionThreshold: number,
    private recentKeep: number,
    private compactionBytesThreshold: number,
    private limits: ICompactionLimits = DEFAULT_LIMITS,
  ) {}

  /** Update the thresholds used by future compact() calls. */
  updateConfig(compactionThreshold: number, recentKeep: number, compactionBytesThreshold: number, limits?: ICompactionLimits): void {
    this.compactionThreshold = compactionThreshold
    this.recentKeep = recentKeep
    this.compactionBytesThreshold = compactionBytesThreshold
    if (limits) this.limits = limits
  }

  /** The most recent compaction of a session and why it ran. */
  lastCompaction(sessionId: string): { reason: CompactionReason; ts: number } | undefined {
    return this.last.get(sessionId)
  }

  /**
   * Shrink a session's history to an archive summary plus the recent tail.
   * Runs at task boundaries, on idle sweeps and on operator request; while a
   * task is in flight it waits, because the summary would lose the paths and
   * partial results the task is working with — unless the history is within
   * `hardLimitPct` of the model's budget, when losing some is better than
   * losing the turn (CLEAN-150 US4).
   */
  async compact(sessionId: string, llm: ILlmGateway, opts: ICompactOptions = {}): Promise<void> {
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
    if (!opts.force && !overCount && !overBytes) return
    if (events.length <= this.recentKeep) return

    let reason: CompactionReason = opts.reason ?? "boundary"
    if (opts.inFlight && !opts.force) {
      const hardLimit = (this.limits.hardLimitPct / 100) * this.limits.contextBudgetChars
      if (bytes < hardLimit) {
        log.info(`deferring compaction for ${sessionId}: a task is in flight (${Math.round(bytes / 1024)}KB < hard limit ${Math.round(hardLimit / 1024)}KB)`)
        return
      }
      reason = "hard-limit"
    }

    const trigger = overBytes ? `${Math.round(bytes / 1024)}KB > ${Math.round(this.compactionBytesThreshold / 1024)}KB` : `${events.length} events`
    log.info(`compacting ${sessionId} [${reason}] (${trigger}): ${events.length} → ${this.recentKeep} events`)
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

      // The in-flight note is what the archive alone would lose: the goal
      // being pursued, the last steps taken, what is still owed.
      const inFlight = inFlightNote(events, opts.pending ?? [])
      const summaryEvent: Event = {
        id: randomUUID(),
        type: "summary",
        ts: Date.now(),
        data: {
          text:
            `[ARCHIVED CONTEXT — search here when user says "I sent you earlier" / "see above"]\n${response.text}\n` +
            `[IN FLIGHT when archived — goal: ${inFlight.goal}; last steps: ${inFlight.done.join(", ") || "none"}; pending: ${inFlight.pending.join("; ") || "none"}]\n` +
            `[END ARCHIVED CONTEXT]`,
          reason,
          inFlight,
        },
      }

      await this.sessionService.rewrite(sessionId, [summaryEvent, ...recent, ...newlyAppended])
      this.last.set(sessionId, { reason, ts: summaryEvent.ts })
      log.info(`compaction done: ${sessionId} [${reason}]${newlyAppended.length > 0 ? ` (+${newlyAppended.length} appended during compaction)` : ""}`)
    } finally {
      this.compacting.delete(sessionId)
    }
  }

  compactAsync(sessionId: string, llm: ILlmGateway, opts: ICompactOptions = {}): void {
    this.compact(sessionId, llm, opts).catch(err => {
      log.error(`compaction failed for ${sessionId}`, err)
    })
  }
}

/** Goal = the latest user message; done = the last three tool calls; pending = whatever the caller still owes. */
export function inFlightNote(events: Event[], pending: string[]): IInFlightNote {
  const lastUser = [...events].reverse().find(e => e.type === "user")
  const goal = String((lastUser?.data as { text?: string } | undefined)?.text ?? "").replace(/\s+/g, " ").slice(0, 200) || "(none)"
  const done = events
    .filter(e => e.type === "tool_call")
    .slice(-3)
    .map(e => String((e.data as { name?: string }).name ?? "?"))
  return { goal, done, pending: pending.slice(0, 5) }
}
