import type { MemoryEntry, MemoryLimits, MemoryReviewConfig } from "./domain/memory.types"
import type { Event } from "../../setup/event"
import type { LlmModule } from "../../setup/llm/llm.module"
import type { SessionModule } from "../session/session.module"
import { DEFAULT_MEMORY_LIMITS, DEFAULT_MEMORY_REVIEW } from "./domain/memory.types"
import { MemoryService } from "./domain/memory.service"
import { MemoryGateway } from "./data/memory.gateway"

export class MemoryModule {
  private service: MemoryService

  constructor(
    private agentDir: string,
    limits: MemoryLimits = DEFAULT_MEMORY_LIMITS,
    review: MemoryReviewConfig = DEFAULT_MEMORY_REVIEW,
  ) {
    this.service = new MemoryService(new MemoryGateway(agentDir, limits), review)
  }

  async load(): Promise<void> {
    await this.service.load(this.agentDir)
  }

  search(query: string): MemoryEntry[] {
    return this.service.search(query)
  }

  insert(entry: MemoryEntry): void {
    this.service.insert(entry)
  }

  appendDaily(text: string): void {
    this.service.appendDaily(text)
  }

  readRecentDaily(): string | undefined {
    return this.service.readRecentDaily()
  }

  ensureAdminInMemory(adminIds: string[]): void {
    this.service.ensureAdminInMemory(adminIds)
  }

  flushAndCompact(sessionId: string, history: Event[], llm: LlmModule, session: SessionModule, compactionThreshold: number): void {
    this.service.flushAndCompact(sessionId, history, llm, session, compactionThreshold)
  }

  reviewMemory(sessionId: string, llm: LlmModule, session: SessionModule): void {
    this.service.reviewMemory(sessionId, llm, session)
  }
}
