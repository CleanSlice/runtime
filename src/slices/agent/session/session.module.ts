import type { Event } from "../../setup/event"
import type { ILlmGateway } from "../../setup/llm/domain/llm.gateway"
import { SessionGateway } from "./data/session.gateway"
import { SessionService } from "./domain/session.service"
import { CompactionService } from "./domain/compaction.service"
import type { IActivityReporter } from "./domain/activity"

export interface SessionConfig {
  compactionThreshold?: number
  recentKeep?: number
  compactionBytesThreshold?: number
}

export const SESSION_CONFIG_DEFAULTS: Required<SessionConfig> = {
  compactionThreshold: 60,
  recentKeep: 20,
  compactionBytesThreshold: 200_000,
}

export class SessionModule {
  private service: SessionService
  private compaction: CompactionService

  constructor(agentDir: string, config?: SessionConfig) {
    this.service = new SessionService(new SessionGateway(agentDir))
    this.compaction = new CompactionService(
      this.service,
      config?.compactionThreshold ?? SESSION_CONFIG_DEFAULTS.compactionThreshold,
      config?.recentKeep ?? SESSION_CONFIG_DEFAULTS.recentKeep,
      config?.compactionBytesThreshold ?? SESSION_CONFIG_DEFAULTS.compactionBytesThreshold,
    )
  }

  /**
   * Refresh the compaction thresholds after construction — needed because
   * they're captured as plain numbers, not an object reference, so they
   * can't pick up a config reload (e.g. after an S3 restore) on their own.
   */
  updateCompactionConfig(config?: SessionConfig): void {
    this.compaction.updateConfig(
      config?.compactionThreshold ?? SESSION_CONFIG_DEFAULTS.compactionThreshold,
      config?.recentKeep ?? SESSION_CONFIG_DEFAULTS.recentKeep,
      config?.compactionBytesThreshold ?? SESSION_CONFIG_DEFAULTS.compactionBytesThreshold,
    )
  }

  getOrCreate(channelId: string, userId: string) {
    return this.service.getOrCreate(channelId, userId)
  }

  touch(sessionId: string): void {
    this.service.touch(sessionId)
  }

  setActivityReporter(reporter: IActivityReporter): void {
    this.service.setActivityReporter(reporter)
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
