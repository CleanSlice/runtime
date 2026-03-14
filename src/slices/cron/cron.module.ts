import type { Job } from "./domain/cron.types"
import { shouldRun } from "./domain/cron.parser"
import { CronGateway } from "./data/cron.gateway"

export class CronScheduler {
  private store: CronGateway
  private interval?: ReturnType<typeof setInterval>
  private handler?: (job: Job) => Promise<void>

  constructor(agentDir: string) {
    this.store = new CronGateway(agentDir)
  }

  onJob(handler: (job: Job) => Promise<void>): void {
    this.handler = handler
  }

  start(): void {
    this.interval = setInterval(async () => {
      const now = new Date()
      const jobs = await this.store.load()
      for (const job of jobs) {
        if (!job.enabled) continue
        if (shouldRun(job, now)) {
          job.lastRunAt = Date.now()
          await this.store.save(jobs)
          await this.handler?.(job)
        }
      }
    }, 60_000)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }
}
