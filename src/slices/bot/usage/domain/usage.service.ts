import type { IUsageGateway } from "./usage.gateway"
import type { IDailyUsage } from "./usage.types"
import type { ModelUsage } from "../../../setup/llm/domain/llm.types"

export class UsageService {
  private current: IDailyUsage
  private botId: string
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private readonly gateway: IUsageGateway,
    botId: string,
  ) {
    this.botId = botId
    this.current = this.loadOrInit()
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10) // "YYYY-MM-DD"
  }

  private empty(): IDailyUsage {
    return {
      date: this.today(),
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCallCount: 0,
      byCredential: {},
      byModel: {},
      reportedAt: null,
    }
  }

  private loadOrInit(): IDailyUsage {
    const saved = this.gateway.load()
    if (saved && saved.date === this.today()) {
      console.log(`[usage] resumed daily stats: ${saved.totalCallCount} calls, ${saved.totalInputTokens} input tokens`)
      return saved
    }
    return this.empty()
  }

  /** Call after each LLM response */
  add(usage: ModelUsage | undefined): void {
    if (!usage) return

    // Roll over if day changed
    if (this.current.date !== this.today()) {
      this.current = this.empty()
    }

    const credId = usage.credentialId ?? "unknown"
    const modelName = usage.model ?? "unknown"
    this.current.totalInputTokens += usage.inputTokens
    this.current.totalOutputTokens += usage.outputTokens
    this.current.totalCallCount += 1

    if (!this.current.byCredential[credId]) {
      this.current.byCredential[credId] = { inputTokens: 0, outputTokens: 0, callCount: 0 }
    }
    this.current.byCredential[credId].inputTokens += usage.inputTokens
    this.current.byCredential[credId].outputTokens += usage.outputTokens
    this.current.byCredential[credId].callCount += 1

    // Per-model rollup — fed to ranch's POST /agents/:id/usage. Backfill the
    // map for legacy usage.json files that pre-date this field.
    if (!this.current.byModel) this.current.byModel = {}
    if (!this.current.byModel[modelName]) {
      this.current.byModel[modelName] = { inputTokens: 0, outputTokens: 0, callCount: 0 }
    }
    this.current.byModel[modelName].inputTokens += usage.inputTokens
    this.current.byModel[modelName].outputTokens += usage.outputTokens
    this.current.byModel[modelName].callCount += 1
    // Track which credential billed for this model — last write wins, which
    // is fine since aux + main usually share a credential.
    if (usage.credentialId) {
      this.current.byModel[modelName].llmCredentialId = usage.credentialId
    }

    // Persist to file (S3 sync will pick it up)
    this.gateway.save(this.current)
  }

  /** Send daily stats to API */
  async report(): Promise<void> {
    if (this.current.totalCallCount === 0) return
    try {
      await this.gateway.report(this.botId, this.current)
      this.current.reportedAt = new Date().toISOString()
      this.gateway.save(this.current)
      console.log(`[usage] reported: ${this.current.totalCallCount} calls, ${this.current.totalInputTokens} in / ${this.current.totalOutputTokens} out`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[usage] report failed: ${msg}`)
    }
  }

  /**
   * Start the periodic reporter. Default interval = 5 minutes — small enough
   * for the dashboard to feel near-realtime, large enough to coalesce
   * many LLM calls into one POST. Set to 0 to disable scheduled reporting
   * (the agent will still report on graceful shutdown via flush()).
   */
  startReportCron(intervalMs = 5 * 60_000): void {
    if (intervalMs <= 0) return
    this.timer = setInterval(() => {
      this.report().catch(() => {})
    }, intervalMs)
  }

  stopReportCron(): void {
    if (this.timer) clearInterval(this.timer)
  }

  /** @deprecated kept for callers that haven't migrated. Use startReportCron(). */
  startDailyCron(): void {
    this.startReportCron()
  }

  /** @deprecated kept for callers that haven't migrated. Use stopReportCron(). */
  stopDailyCron(): void {
    this.stopReportCron()
  }
}
