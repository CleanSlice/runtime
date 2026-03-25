import { UsageService } from "./domain/usage.service"
import { UsageGateway } from "./data/usage.gateway"

export class UsageModule {
  private service: UsageService

  constructor(agentDir: string) {
    const botId = process.env.BOT_ID ?? ""
    this.service = new UsageService(new UsageGateway(agentDir), botId)
  }

  start(): void {
    this.service.startDailyCron()
  }

  add(usage: Parameters<UsageService["add"]>[0]): void {
    this.service.add(usage)
  }

  async flush(): Promise<void> {
    this.service.stopDailyCron()
    await this.service.report()
  }
}
