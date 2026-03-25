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
    this.current.totalInputTokens += usage.inputTokens
    this.current.totalOutputTokens += usage.outputTokens
    this.current.totalCallCount += 1

    if (!this.current.byCredential[credId]) {
      this.current.byCredential[credId] = { inputTokens: 0, outputTokens: 0, callCount: 0 }
    }
    this.current.byCredential[credId].inputTokens += usage.inputTokens
    this.current.byCredential[credId].outputTokens += usage.outputTokens
    this.current.byCredential[credId].callCount += 1

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
    } catch (err) {
      console.error(`[usage] report failed:`, err)
    }
  }

  /** Start daily cron: report at 23:50 UTC */
  startDailyCron(): void {
    const MS_PER_MIN = 60_000
    const checkInterval = setInterval(() => {
      const now = new Date()
      if (now.getUTCHours() === 23 && now.getUTCMinutes() === 50) {
        this.report().catch(() => {})
      }
    }, MS_PER_MIN)
    this.timer = checkInterval
  }

  stopDailyCron(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
