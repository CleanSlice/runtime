import type { ICronGateway } from "./cron.gateway"
import type { Job } from "./cron.types"
import { parseCron } from "../data/cron.parser"

export class CronService {
  constructor(private gateway: ICronGateway) {}

  async list(): Promise<Job[]> {
    return this.gateway.load()
  }

  async add(job: Job): Promise<void> {
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

  shouldRun(job: Job, now: Date): boolean {
    const cron = parseCron(job.schedule)
    return (
      (cron.minute === null || cron.minute === now.getMinutes()) &&
      (cron.hour   === null || cron.hour   === now.getHours())   &&
      (cron.dom    === null || cron.dom    === now.getDate())     &&
      (cron.month  === null || cron.month  === now.getMonth() + 1) &&
      (cron.dow    === null || cron.dow    === now.getDay())
    )
  }
}
