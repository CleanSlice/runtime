import type { Job } from "./domain/Job"
import { JobStore } from "./data/JobStore"

function parseCron(expr: string): { minute: number | null; hour: number | null; dom: number | null; month: number | null; dow: number | null } {
  const parts = expr.trim().split(/\s+/)
  const parse = (p: string) => (p === "*" ? null : parseInt(p, 10))
  return {
    minute: parse(parts[0] ?? "*"),
    hour: parse(parts[1] ?? "*"),
    dom: parse(parts[2] ?? "*"),
    month: parse(parts[3] ?? "*"),
    dow: parse(parts[4] ?? "*"),
  }
}

function shouldRun(job: Job, now: Date): boolean {
  const cron = parseCron(job.schedule)
  return (
    (cron.minute === null || cron.minute === now.getMinutes()) &&
    (cron.hour === null || cron.hour === now.getHours()) &&
    (cron.dom === null || cron.dom === now.getDate()) &&
    (cron.month === null || cron.month === now.getMonth() + 1) &&
    (cron.dow === null || cron.dow === now.getDay())
  )
}

export class CronScheduler {
  private store: JobStore
  private interval?: ReturnType<typeof setInterval>
  private handler?: (job: Job) => Promise<void>

  constructor(agentDir: string) {
    this.store = new JobStore(agentDir)
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
