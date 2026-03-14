import { Database } from "bun:sqlite"
import type { IMemoryGateway } from "../domain/memory.gateway"
import type { MemoryEntry } from "../domain/memory.types"

export class MemoryGateway implements IMemoryGateway {
  private db: Database

  constructor(agentDir: string) {
    this.db = new Database(`${agentDir}/data/memory.sqlite`, { create: true })
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memory (
        id TEXT PRIMARY KEY,
        content TEXT,
        source TEXT,
        ts INTEGER
      )
    `)
  }

  insert(entry: MemoryEntry): void {
    this.db.run(
      "INSERT OR REPLACE INTO memory (id, content, source, ts) VALUES (?, ?, ?, ?)",
      [entry.id, entry.content, entry.source, entry.ts]
    )
  }

  search(query: string): MemoryEntry[] {
    return this.db
      .query<MemoryEntry, [string]>(
        "SELECT * FROM memory WHERE content LIKE ? ORDER BY ts DESC LIMIT 20"
      )
      .all(`%${query}%`)
  }
}
