import type { CronJob } from "./domain/cron.types"
import { CronService } from "./domain/cron.service"
import { CronGateway } from "./data/cron.gateway"

export class CronModule {
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
      const nowMs = Date.now()
      const jobs = await this.service.list()
      for (const job of jobs) {
        if (!job.enabled) continue

        let shouldFire = false

        if (job.runAt) {
          // One-shot: fire when current time passes runAt
          shouldFire = nowMs >= job.runAt && (!job.lastRunAt || job.lastRunAt < job.runAt)
        } else {
          shouldFire = this.service.shouldRun(job, now)
        }

        if (shouldFire) {
          await this.service.updateLastRun(job.id, nowMs)
          await this.handler?.(job)

          // Delete after firing if runOnce or runAt
          if (job.runOnce || job.runAt) {
            await this.service.remove(job.id)
          }
        }
      }
    }, 10_000) // Check every 10s for better one-shot accuracy
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }
}
