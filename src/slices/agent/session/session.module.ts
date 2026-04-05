import type { Event } from "../../setup/event"
import type { ILlmGateway } from "../../setup/llm/domain/llm.gateway"
import { SessionGateway } from "./data/session.gateway"
import { SessionService } from "./domain/session.service"
import { CompactionService } from "./domain/compaction.service"

export interface SessionConfig {
  compactionThreshold?: number
  recentKeep?: number
}

export class SessionModule {
  private service: SessionService
  private compaction: CompactionService

  constructor(agentDir: string, config?: SessionConfig) {
    this.service = new SessionService(new SessionGateway(agentDir))
    this.compaction = new CompactionService(
      this.service,
      config?.compactionThreshold ?? 60,
      config?.recentKeep ?? 20,
    )
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

  async readForTask(sessionId: string, taskId: string): Promise<Event[]> {
    const all = await this.service.read(sessionId)
    return all.filter(e => !e.taskId || e.taskId === taskId)
  }

  async compact(sessionId: string, llm: ILlmGateway): Promise<void> {
    return this.compaction.compact(sessionId, llm)
  }

  compactAsync(sessionId: string, llm: ILlmGateway): void {
    this.compaction.compactAsync(sessionId, llm)
  }
}
