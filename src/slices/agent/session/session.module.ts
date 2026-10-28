import type { Event } from "../../setup/event"
import type { ILlmGateway } from "../../setup/llm/domain/llm.gateway"
import { SessionGateway } from "./data/session.gateway"
import { SessionService } from "./domain/session.service"
import { CompactionService, type CompactionReason, type ICompactOptions } from "./domain/compaction.service"
import type { IActivityReporter } from "./domain/activity"
import type { ISessionHydrator } from "./domain/session.gateway"
import { createLogger } from "../../setup/logger"

const log = createLogger("session")

export type { CompactionReason, ICompactOptions, IInFlightNote } from "./domain/compaction.service"

export interface SessionConfig {
  compactionThreshold?: number
  recentKeep?: number
  compactionBytesThreshold?: number
  /** The model's history budget; the in-flight hard limit is a percentage of it (CLEAN-150 US4). */
  contextBudgetChars?: number
  hardLimitPct?: number
  /** Sessions idle this long and over threshold are compacted by the heartbeat sweep; 0 disables. */
  idleCompactMin?: number
}

export const SESSION_CONFIG_DEFAULTS: Required<SessionConfig> = {
  compactionThreshold: 60,
  recentKeep: 20,
  compactionBytesThreshold: 200_000,
  contextBudgetChars: 400_000,
  hardLimitPct: 90,
  idleCompactMin: 30,
}

export class SessionModule {
  private service: SessionService
  private compaction: CompactionService
  private idleCompactMin: number
  private gateway: SessionGateway

  constructor(agentDir: string, config?: SessionConfig) {
    const c = { ...SESSION_CONFIG_DEFAULTS, ...stripUndefined(config) }
    this.gateway = new SessionGateway(agentDir)
    this.service = new SessionService(this.gateway)
    this.compaction = new CompactionService(
      this.service,
      c.compactionThreshold,
      c.recentKeep,
      c.compactionBytesThreshold,
      { contextBudgetChars: c.contextBudgetChars, hardLimitPct: c.hardLimitPct },
    )
    this.idleCompactMin = c.idleCompactMin
  }

  /**
   * Refresh the compaction thresholds after construction — needed because
   * they're captured as plain numbers, not an object reference, so they
   * can't pick up a config reload (e.g. after an S3 restore) on their own.
   */
  updateCompactionConfig(config?: SessionConfig): void {
    const c = { ...SESSION_CONFIG_DEFAULTS, ...stripUndefined(config) }
    this.compaction.updateConfig(c.compactionThreshold, c.recentKeep, c.compactionBytesThreshold, {
      contextBudgetChars: c.contextBudgetChars,
      hardLimitPct: c.hardLimitPct,
    })
    this.idleCompactMin = c.idleCompactMin
  }

  /** Route transcript access through the remote-storage restore (S3 background pull). */
  setHydrator(hydrator: ISessionHydrator): void {
    this.gateway.setHydrator(hydrator)
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

  async compact(sessionId: string, llm: ILlmGateway, opts?: ICompactOptions): Promise<void> {
    return this.compaction.compact(sessionId, llm, opts)
  }

  compactAsync(sessionId: string, llm: ILlmGateway, opts?: ICompactOptions): void {
    this.compaction.compactAsync(sessionId, llm, opts)
  }

  lastCompaction(sessionId: string): { reason: CompactionReason; ts: number } | undefined {
    return this.compaction.lastCompaction(sessionId)
  }

  /**
   * Idle sweep (CLEAN-150 US4): compact every session that has been quiet
   * for `idleCompactMin` and is over threshold, skipping sessions with a
   * task in flight. Returns the session ids compacted.
   */
  async compactIdle(llm: ILlmGateway, now: number, inFlight: (sessionId: string) => boolean): Promise<string[]> {
    if (this.idleCompactMin <= 0) return []
    const cutoff = now - this.idleCompactMin * 60_000
    const swept: string[] = []
    for (const s of this.service.listSessions()) {
      if (s.updatedAt > cutoff || inFlight(s.id)) continue
      const before = (await this.service.read(s.id)).length
      await this.compaction.compact(s.id, llm, { reason: "idle" })
      if ((await this.service.read(s.id)).length < before) swept.push(s.id)
    }
    if (swept.length > 0) log.info(`idle sweep compacted ${swept.length} session(s)`)
    return swept
  }
}

function stripUndefined<T extends object>(o: T | undefined): Partial<T> {
  if (!o) return {}
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}
