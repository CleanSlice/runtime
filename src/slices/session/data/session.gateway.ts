import type { ISessionGateway } from "../domain/session.gateway"
import type { Event } from "../../event/event.module"
import { mkdirSync } from "fs"
import { appendFile } from "fs/promises"

export class JsonlSessionGateway implements ISessionGateway {
  private dir: string

  constructor(agentDir: string) {
    this.dir = `${agentDir}/data/sessions`
    mkdirSync(this.dir, { recursive: true })
  }

  async append(sessionId: string, event: Event): Promise<void> {
    const path = `${this.dir}/${sessionId}.jsonl`
    const line = JSON.stringify(event) + "\n"
    await appendFile(path, line)
  }

  async read(sessionId: string): Promise<Event[]> {
    const path = `${this.dir}/${sessionId}.jsonl`
    try {
      const text = await Bun.file(path).text()
      return text
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as Event)
    } catch {
      return []
    }
  }
}
