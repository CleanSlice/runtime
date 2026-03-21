import type { ICronGateway } from "../domain/cron.gateway"
import type { CronJob } from "../domain/cron.types"
import { parseCron, type CronExpression } from "./cron.parser"
import { mkdirSync } from "fs"

export class CronGateway implements ICronGateway {
  private path: string

  constructor(agentDir: string) {
    mkdirSync(`${agentDir}/data`, { recursive: true })
    this.path = `${agentDir}/data/cron.json`
  }

  async load(): Promise<CronJob[]> {
    try {
      const text = await Bun.file(this.path).text()
      return JSON.parse(text) as CronJob[]
    } catch {
      return []
    }
  }

  async save(jobs: CronJob[]): Promise<void> {
    await Bun.write(this.path, JSON.stringify(jobs, null, 2))
  }

  parse(schedule: string): CronExpression {
    return parseCron(schedule)
  }
}
