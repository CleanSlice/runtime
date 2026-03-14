import type { CronGateway } from "../domain/cron.gateway"
import type { Job } from "../domain/cron.types"
import { mkdirSync } from "fs"

export class CronStore implements CronGateway {
  private path: string

  constructor(agentDir: string) {
    mkdirSync(`${agentDir}/data`, { recursive: true })
    this.path = `${agentDir}/data/cron.json`
  }

  async load(): Promise<Job[]> {
    try {
      const text = await Bun.file(this.path).text()
      return JSON.parse(text) as Job[]
    } catch {
      return []
    }
  }

  async save(jobs: Job[]): Promise<void> {
    await Bun.write(this.path, JSON.stringify(jobs, null, 2))
  }
}
