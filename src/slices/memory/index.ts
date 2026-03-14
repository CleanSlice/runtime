import { SqliteMemoryGateway } from "./data/memory.gateway"
import type { MemoryEntry } from "./domain/memory.types"
import { existsSync } from "fs"

const MD_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"]

export class MemoryManager {
  private index: SqliteMemoryGateway

  constructor(private agentDir: string) {
    this.index = new SqliteMemoryGateway(agentDir)
  }

  async load(): Promise<void> {
    for (const file of MD_FILES) {
      const path = `${this.agentDir}/${file}`
      if (!existsSync(path)) continue
      const content = await Bun.file(path).text()
      const entry: MemoryEntry = {
        id: file,
        content,
        source: file,
        ts: Date.now(),
      }
      this.index.insert(entry)
    }
  }

  search(query: string): MemoryEntry[] {
    return this.index.search(query)
  }

  insert(entry: MemoryEntry): void {
    this.index.insert(entry)
  }
}
