import type { CronGateway } from "./cron.gateway"
import type { Job } from "./cron.types"

export class CronService {
  constructor(private gateway: CronGateway) {}

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
}
