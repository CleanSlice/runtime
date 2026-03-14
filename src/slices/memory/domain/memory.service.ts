import type { IMemoryGateway } from "./memory.gateway"
import type { MemoryEntry } from "./memory.types"
import { existsSync } from "fs"

const MD_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"]

export class MemoryService {
  constructor(private gateway: IMemoryGateway) {}

  async load(agentDir: string): Promise<void> {
    for (const file of MD_FILES) {
      const path = `${agentDir}/${file}`
      if (!existsSync(path)) continue
      const content = await Bun.file(path).text()
      this.gateway.insert({ id: file, content, source: file, ts: Date.now() })
    }
  }

  insert(entry: MemoryEntry): void {
    this.gateway.insert(entry)
  }

  search(query: string): MemoryEntry[] {
    return this.gateway.search(query)
  }
}
