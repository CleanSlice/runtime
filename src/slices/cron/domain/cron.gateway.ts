import type { Job } from "./cron.types"

export interface ICronGateway {
  load(): Promise<Job[]>
  save(jobs: Job[]): Promise<void>
}
