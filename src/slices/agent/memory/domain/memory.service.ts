import type { IMemoryGateway } from "./memory.gateway"
import type { MemoryEntry, MemoryReviewConfig } from "./memory.types"
import type { Event } from "../../../setup/event"
import type { LlmModule } from "../../../setup/llm/llm.module"
import type { SessionModule } from "../../session/session.module"
import { estimateEventsBytes, trimForSummary, SUMMARY_INPUT_MAX_CHARS } from "../../session/domain/compaction.service"
import { fitEventsToBudget } from "../../session/domain/contextBudget"
import { DEFAULT_MEMORY_REVIEW, MEMORY_LEARNED_HEADING } from "./memory.types"
import { buildAdminOwnerPrompt } from "../../agent/domain/prompts/admin-owner.prompt"
import { buildMemoryFlushPrompt, buildMemoryReviewPrompt } from "../../agent/domain/prompts/error-hint.prompt"
import type { InstinctModule } from "../../instinct/instinct.module"
import type { ReviewItem } from "../../instinct/domain/instinct.types"
import { buildInstinctReviewPrompt, parseInstinctReview } from "../../instinct/domain/prompts/instinct-review.prompt"
import { createLogger } from "../../../setup/logger"

const MD_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"]

const SOURCES = new Set(["correction", "error-resolution", "repetition", "explicit-rule"])

/** Shape check for one item of the curator's JSON — anything else is dropped. */
function isReviewItem(x: unknown): x is ReviewItem {
  if (!x || typeof x !== "object") return false
  const r = x as Record<string, unknown>
  if (r.kind === "new") {
    return typeof r.trigger === "string" && r.trigger.trim().length > 0 &&
      typeof r.action === "string" && r.action.trim().length > 0 &&
      SOURCES.has(r.source as string)
  }
  return (r.kind === "reinforce" || r.kind === "correct") && typeof r.id === "string"
}

/** Evidence refs the model wrote without a session prefix get this session's. */
function withSessionRefs(item: ReviewItem, sessionId: string): ReviewItem {
  if (item.kind !== "new") return item
  const evidence = (Array.isArray(item.evidence) ? item.evidence : [])
    .filter(e => e && typeof e === "object")
    .map(e => ({
      ref: typeof e.ref === "string" && e.ref.includes(":") ? e.ref : `session:${sessionId}#${typeof e.ref === "string" ? e.ref : "?"}`,
      ts: typeof e.ts === "number" ? e.ts : Date.now(),
      ...(typeof e.note === "string" ? { note: e.note } : {}),
    }))
  return { ...item, evidence: evidence.length > 0 ? evidence : [{ ref: `session:${sessionId}`, ts: Date.now() }] }
}

const initLog = createLogger("init")
const log = createLogger("memory-flush")
const reviewLog = createLogger("memory-review")

export class MemoryService {
  /** Per-session counter for the background review cadence. */
  private reviewCounters = new Map<string, number>()

  constructor(
    private gateway: IMemoryGateway,
    private review: MemoryReviewConfig = DEFAULT_MEMORY_REVIEW,
    /** When present, the review pass also teaches behaviours (CLEAN-150 US3). */
    private instincts?: Pick<InstinctModule, "list" | "applyReview" | "enabled">,
  ) {}

  // ─── Search / Insert ───────────────────────────────────────────────

  async load(agentDir: string): Promise<void> {
    // Bound the curated files on disk before indexing them, so both the
    // search index and the system-prompt builder see the truncated version.
    // The operator hears about every cut: which file, how much, and whether
    // the rules alone no longer fit (CLEAN-150 FR-008).
    for (const r of this.gateway.enforceMdLimits()) {
      if (r.over) {
        initLog.warn(`${r.file}: the ## Rules section alone is ${r.chars} chars, over the ${r.limit}-char limit — ` +
          `all reference material was dropped; shorten the rules or raise memory.limits`)
      } else {
        initLog.warn(`${r.file}: ${r.dropped} chars of reference material dropped to fit the ${r.limit}-char limit (rules kept)`)
      }
    }

    for (const file of MD_FILES) {
      const path = `${agentDir}/${file}`
      try {
        const content = await Bun.file(path).text()
        this.gateway.insert({ id: file, content, source: file, ts: Date.now() })
      } catch {
        // file may not exist
      }
    }
  }

  insert(entry: MemoryEntry): void {
    this.gateway.insert(entry)
  }

  search(query: string): MemoryEntry[] {
    return this.gateway.search(query)
  }

  // ─── Daily memory ─────────────────────────────────────────────────

  appendDaily(text: string): void {
    this.gateway.appendDaily(text)
  }

  readRecentDaily(): string | undefined {
    return this.gateway.readRecentDaily()
  }

  // ─── Admin memory (MEMORY.md) ─────────────────────────────────────

  ensureAdminInMemory(adminIds: string[]): void {
    if (adminIds.length === 0) return

    const marker = "## Bot Owner"
    const ownerBlock = buildAdminOwnerPrompt(adminIds)
    const content = this.gateway.readMemoryFile()

    if (content) {
      if (content.includes(marker)) {
        const updated = content.replace(
          new RegExp(`${marker}[\\s\\S]*?(?=\\n## |$)`),
          ownerBlock,
        )
        this.gateway.writeMemoryFile(updated)
      } else {
        this.gateway.writeMemoryFile(content + "\n" + ownerBlock)
      }
    } else {
      this.gateway.writeMemoryFile(ownerBlock)
    }
    initLog.info(`admin IDs written to MEMORY.md: ${adminIds.join(", ")}`)
  }

  // ─── Memory flush + compaction ─────────────────────────────────────

  flushAndCompact(sessionId: string, history: Event[], llm: LlmModule, session: SessionModule, compactionThreshold: number, compactionBytesThreshold: number): void {
    this.doFlush(sessionId, history, llm, session, compactionThreshold, compactionBytesThreshold).catch(err =>
      log.error("unhandled", err)
    )
  }

  private async doFlush(sessionId: string, _history: Event[], llm: LlmModule, session: SessionModule, compactionThreshold: number, compactionBytesThreshold: number): Promise<void> {
    const events = await session.read(sessionId)
    // Flush + compact when either the event COUNT or the serialized SIZE is
    // over budget — a few huge tool_results can overflow context long before
    // the count threshold is hit.
    if (events.length <= compactionThreshold && estimateEventsBytes(events) <= compactionBytesThreshold) return

    log.info(`flushing session ${sessionId} before compaction`)
    try {
      const existing = this.readRecentDaily() ?? ""
      // Memory flush + compaction are background summarization tasks — route
      // through the auxiliary LLM (cheaper model, no contention with the
      // main session's prompt cache). Falls back to main when no aux is set.
      // Bounded like compaction's input (CLEAN-124): this call must not be
      // the one that fails on the very session it is meant to shrink.
      const bounded = fitEventsToBudget(events.map(trimForSummary), SUMMARY_INPUT_MAX_CHARS).events
      const response = await llm.auxComplete(buildMemoryFlushPrompt(existing), bounded, [])

      const text = response.text?.trim()
      if (text && text !== "NOTHING") {
        this.appendDaily(text)
        log.info(`saved ${text.split("\n").length} notes`)
      }
    } catch (err) {
      log.error("failed", err)
    }

    session.compactAsync(sessionId, llm.getAuxGateway())
  }

  // ─── Background self-improvement review ────────────────────────────

  /**
   * Count one completed turn for `sessionId`. Every `everyTurns` turns, fire a
   * background review that promotes durable facts from the conversation into
   * MEMORY.md. Best-effort and fire-and-forget — runs after the response is
   * delivered and never blocks the turn or touches the main prompt cache.
   */
  reviewMemory(sessionId: string, llm: LlmModule, session: SessionModule): void {
    if (!this.review.enabled || this.review.everyTurns <= 0) return

    const next = (this.reviewCounters.get(sessionId) ?? 0) + 1
    if (next < this.review.everyTurns) {
      this.reviewCounters.set(sessionId, next)
      return
    }
    this.reviewCounters.set(sessionId, 0)

    this.doReview(sessionId, llm, session).catch(err => reviewLog.error("unhandled", err))
  }

  /**
   * Review a session that is ending (e.g. `/clear`) regardless of the turn
   * cadence, so short conversations that never reached `everyTurns` still get
   * reviewed. Events are read up front so the caller can clear the session
   * immediately afterwards without racing the background pass.
   */
  async flushReview(sessionId: string, llm: LlmModule, session: SessionModule): Promise<void> {
    if (!this.review.enabled) return

    const pending = this.reviewCounters.get(sessionId) ?? 0
    if (pending === 0) return  // nothing new since the last review

    this.reviewCounters.delete(sessionId)
    const events = await session.read(sessionId)
    if (events.length === 0) return

    this.doReview(sessionId, llm, session, events).catch(err => reviewLog.error("unhandled", err))
  }

  /**
   * Flush reviews for every session with pending turns. Awaited on graceful
   * shutdown so promoted facts land in MEMORY.md before the final S3 push.
   * Bounded by a timeout so a slow auxiliary LLM can't block process exit.
   */
  async flushAllPendingReviews(llm: LlmModule, session: SessionModule): Promise<void> {
    if (!this.review.enabled) return

    const pending = [...this.reviewCounters.entries()].filter(([, n]) => n > 0).map(([sid]) => sid)
    this.reviewCounters.clear()
    if (pending.length === 0) return

    const work = Promise.all(pending.map(async sid => {
      try {
        const events = await session.read(sid)
        if (events.length > 0) await this.doReview(sid, llm, session, events)
      } catch (err) {
        reviewLog.error(`flush failed for ${sid}`, err)
      }
    }))
    const timeout = new Promise<void>(resolve => setTimeout(resolve, 20_000))
    await Promise.race([work, timeout])
  }

  private async doReview(sessionId: string, llm: LlmModule, session: SessionModule, events?: Event[]): Promise<void> {
    const evts = events ?? await session.read(sessionId)
    if (evts.length === 0) return
    await this.reviewNow(sessionId, llm, evts)
  }

  /**
   * One review pass over `events`. With an instinct store the curator answers
   * in JSON — facts for MEMORY.md plus behaviours to create, reinforce or
   * correct; without one it falls back to the `[fact]/[workflow]` lines.
   * Best-effort: a malformed answer teaches nothing and changes nothing.
   */
  async reviewNow(sessionId: string, llm: Pick<LlmModule, "auxComplete">, evts: Event[]): Promise<void> {
    reviewLog.info(`reviewing session ${sessionId}`)
    try {
      const existing = this.gateway.readMemoryFile() ?? ""
      if (!this.instincts?.enabled) {
        // Auxiliary LLM — cheaper model, no contention with the main prompt cache.
        const response = await llm.auxComplete(buildMemoryReviewPrompt(existing), evts, [])
        this.fileFacts(existing, this.dedupeReviewLines(response.text?.trim() ?? "", existing))
        return
      }

      const response = await llm.auxComplete(buildInstinctReviewPrompt(existing, this.instincts.list()), evts, [])
      const parsed = parseInstinctReview(response.text)
      if (!parsed) return

      this.fileFacts(existing, this.dedupeReviewLines(parsed.facts.join("\n"), existing))

      const items = parsed.instincts.filter(isReviewItem).map(i => withSessionRefs(i, sessionId))
      if (items.length === 0) return
      const applied = this.instincts.applyReview(items)
      reviewLog.info(
        `instincts: +${applied.created.length} new, ${applied.reinforced.length} reinforced, ${applied.corrected.length} corrected` +
        (applied.ignored.length ? `, ${applied.ignored.length} unknown ids ignored` : ""),
      )
    } catch (err) {
      reviewLog.error("failed", err)
    }
  }

  private fileFacts(existing: string, lines: string[]): void {
    if (lines.length === 0) return
    this.gateway.writeMemoryFile(this.fileLearnedEntries(existing, lines))
    reviewLog.info(`promoted ${lines.length} entries to MEMORY.md`)
  }

  /** Keep only tagged lines not already present anywhere in MEMORY.md. */
  private dedupeReviewLines(text: string, existing: string): string[] {
    const seen = new Set(existing.split("\n").map(l => l.trim()))
    return text
      .split("\n")
      .map(l => l.trim())
      .filter(l => /^\[(fact|workflow)\]/i.test(l) && !seen.has(l))
  }

  /** Append entries under the `## Learned` heading, creating it if absent. */
  private fileLearnedEntries(existing: string, lines: string[]): string {
    const block = lines.join("\n")
    const headingAt = existing.indexOf(MEMORY_LEARNED_HEADING)

    if (headingAt === -1) {
      return `${existing.trimEnd()}\n\n${MEMORY_LEARNED_HEADING}\n${block}\n`
    }

    // Insert at the end of the existing Learned section (before the next
    // "## " heading, or at end of file) so it survives the Bot Owner rewrite.
    const nextHeadingAt = existing.indexOf("\n## ", headingAt + MEMORY_LEARNED_HEADING.length)
    const cut = nextHeadingAt === -1 ? existing.length : nextHeadingAt
    return `${existing.slice(0, cut).trimEnd()}\n${block}\n${existing.slice(cut)}`
  }
}
