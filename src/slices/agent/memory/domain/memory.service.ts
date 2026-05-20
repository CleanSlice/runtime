import type { IMemoryGateway } from "./memory.gateway"
import type { MemoryEntry, MemoryReviewConfig } from "./memory.types"
import type { Event } from "../../../setup/event"
import type { LlmModule } from "../../../setup/llm/llm.module"
import type { SessionModule } from "../../session/session.module"
import { DEFAULT_MEMORY_REVIEW, MEMORY_LEARNED_HEADING } from "./memory.types"
import { buildAdminOwnerPrompt } from "../../agent/domain/prompts/admin-owner.prompt"
import { buildMemoryFlushPrompt, buildMemoryReviewPrompt } from "../../agent/domain/prompts/error-hint.prompt"
import { createLogger } from "../../../setup/logger"

const MD_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"]

const initLog = createLogger("init")
const log = createLogger("memory-flush")
const reviewLog = createLogger("memory-review")

export class MemoryService {
  /** Per-session counter for the background review cadence. */
  private reviewCounters = new Map<string, number>()

  constructor(
    private gateway: IMemoryGateway,
    private review: MemoryReviewConfig = DEFAULT_MEMORY_REVIEW,
  ) {}

  // ─── Search / Insert ───────────────────────────────────────────────

  async load(agentDir: string): Promise<void> {
    // Bound the curated files on disk before indexing them, so both the
    // search index and the system-prompt builder see the truncated version.
    this.gateway.enforceMdLimits()

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

  flushAndCompact(sessionId: string, history: Event[], llm: LlmModule, session: SessionModule, compactionThreshold: number): void {
    this.doFlush(sessionId, history, llm, session, compactionThreshold).catch(err =>
      log.error("unhandled", err)
    )
  }

  private async doFlush(sessionId: string, _history: Event[], llm: LlmModule, session: SessionModule, compactionThreshold: number): Promise<void> {
    const events = await session.read(sessionId)
    if (events.length <= compactionThreshold) return

    log.info(`flushing session ${sessionId} before compaction`)
    try {
      const existing = this.readRecentDaily() ?? ""
      // Memory flush + compaction are background summarization tasks — route
      // through the auxiliary LLM (cheaper model, no contention with the
      // main session's prompt cache). Falls back to main when no aux is set.
      const response = await llm.auxComplete(buildMemoryFlushPrompt(existing), events, [])

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

  private async doReview(sessionId: string, llm: LlmModule, session: SessionModule): Promise<void> {
    const events = await session.read(sessionId)
    if (events.length === 0) return

    reviewLog.info(`reviewing session ${sessionId}`)
    try {
      const existing = this.gateway.readMemoryFile() ?? ""
      // Auxiliary LLM — cheaper model, no contention with the main prompt cache.
      const response = await llm.auxComplete(buildMemoryReviewPrompt(existing), events, [])

      const text = response.text?.trim()
      if (!text || text === "NOTHING") return

      const newLines = this.dedupeReviewLines(text, existing)
      if (newLines.length === 0) return

      this.gateway.writeMemoryFile(this.fileLearnedEntries(existing, newLines))
      reviewLog.info(`promoted ${newLines.length} entries to MEMORY.md`)
    } catch (err) {
      reviewLog.error("failed", err)
    }
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
