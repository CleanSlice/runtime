import type { Job } from "./cron.types"

export interface CronGateway {
  load(): Promise<Job[]>
  save(jobs: Job[]): Promise<void>
}
