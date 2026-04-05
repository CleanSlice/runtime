import type { IMemoryGateway } from "../domain/memory.gateway"
import type { MemoryEntry } from "../domain/memory.types"
import { SqliteRepository } from "./repositories/sqlite/sqlite.repository"
import { FileRepository } from "./repositories/file/file.repository"

export class MemoryGateway implements IMemoryGateway {
  private sqlite: SqliteRepository
  private file: FileRepository

  constructor(agentDir: string) {
    this.sqlite = new SqliteRepository(agentDir)
    this.file = new FileRepository(agentDir)
  }

  // ─── Search (SQLite) ───────────────────────────────────────────────

  insert(entry: MemoryEntry): void {
    this.sqlite.insert(entry)
  }

  search(query: string): MemoryEntry[] {
    return this.sqlite.search(query)
  }

  // ─── Daily files ──────────────────────────────────────────────────

  appendDaily(text: string): void {
    this.file.appendDaily(text)
  }

  readRecentDaily(): string | undefined {
    return this.file.readRecentDaily()
  }

  // ─── MEMORY.md ────────────────────────────────────────────────────

  readMemoryFile(): string | undefined {
    return this.file.readMemoryFile()
  }

  writeMemoryFile(content: string): void {
    this.file.writeMemoryFile(content)
  }
}
