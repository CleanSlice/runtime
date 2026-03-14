import type { CronJob } from "./domain/cron.types"
import { CronService } from "./domain/cron.service"
import { CronGateway } from "./data/cron.gateway"

export class CronScheduler {
  private service: CronService
  private interval?: ReturnType<typeof setInterval>
  private handler?: (job: CronJob) => Promise<void>

  constructor(agentDir: string) {
    this.service = new CronService(new CronGateway(agentDir))
  }

  onJob(handler: (job: CronJob) => Promise<void>): void {
    this.handler = handler
  }

  start(): void {
    this.interval = setInterval(async () => {
      const now = new Date()
      const jobs = await this.service.list()
      for (const job of jobs) {
        if (!job.enabled) continue
        if (this.service.shouldRun(job, now)) {
          await this.service.updateLastRun(job.id, Date.now())
          await this.handler?.(job)
        }
      }
    }, 60_000)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }
}
