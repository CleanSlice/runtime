import type { CronJob } from "./cron.types"
import type { CronExpression } from "../data/cron.parser"

export interface ICronGateway {
  load(): Promise<CronJob[]>
  save(jobs: CronJob[]): Promise<void>
  parse(schedule: string): CronExpression
}
