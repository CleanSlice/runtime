import { UsageService } from "./domain/usage.service"
import { UsageGateway } from "./data/usage.gateway"
import type { IDailyUsage } from "./domain/usage.types"

export class UsageModule {
  private service: UsageService

  constructor(agentDir: string) {
    // Prefer ranch convention; fall back to BRIDLE_BOT_ID then BOT_ID for
    // pre-ranch / OpenClaw-era deployments still in flight.
    const agentId =
      process.env.BRIDLE_AGENT_ID ??
      process.env.BRIDLE_BOT_ID ??
      process.env.BOT_ID ??
      ""
    this.service = new UsageService(new UsageGateway(agentDir), agentId)
  }

  start(): void {
    this.service.startReportCron()
  }

  add(usage: Parameters<UsageService["add"]>[0]): void {
    this.service.add(usage)
  }

  /** Cloned daily-usage snapshot; safe to JSON-serialize. */
  getCurrent(): IDailyUsage {
    return this.service.getCurrent()
  }

  async flush(): Promise<void> {
    this.service.stopReportCron()
    await this.service.report()
  }
}
