import type { ICronGateway } from "./cron.gateway"
import type { CronJob } from "./cron.types"

export class CronService {
  constructor(private gateway: ICronGateway) {}

  async list(): Promise<CronJob[]> {
    return this.gateway.load()
  }

  async add(job: CronJob): Promise<void> {
    const jobs = await this.gateway.load()
    jobs.push(job)
    await this.gateway.save(jobs)
  }

  async remove(id: string): Promise<void> {
    const jobs = await this.gateway.load()
    await this.gateway.save(jobs.filter(j => j.id !== id))
  }

  async updateLastRun(id: string, ts: number): Promise<void> {
    const jobs = await this.gateway.load()
    const job = jobs.find(j => j.id === id)
    if (job) {
      job.lastRunAt = ts
      await this.gateway.save(jobs)
    }
  }

  shouldRun(job: CronJob, now: Date): boolean {
    const cron = this.gateway.parse(job.schedule)
    return (
      (cron.minute === null || cron.minute === now.getMinutes()) &&
      (cron.hour   === null || cron.hour   === now.getHours())   &&
      (cron.dom    === null || cron.dom    === now.getDate())     &&
      (cron.month  === null || cron.month  === now.getMonth() + 1) &&
      (cron.dow    === null || cron.dow    === now.getDay())
    )
  }
}
