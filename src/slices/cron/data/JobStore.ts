import type { Job } from "../domain/Job"
import { mkdirSync } from "fs"

export class JobStore {
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
