import type { Job } from "./cron.types"
import type { CronExpression } from "../data/cron.parser"

export interface ICronGateway {
  load(): Promise<Job[]>
  save(jobs: Job[]): Promise<void>
  parse(schedule: string): CronExpression
}
