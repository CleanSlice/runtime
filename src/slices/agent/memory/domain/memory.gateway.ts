import type { MemoryEntry } from "./memory.types"

export interface IMemoryGateway {
  // Search (SQLite-backed)
  insert(entry: MemoryEntry): void
  search(query: string): MemoryEntry[]

  // Daily files
  appendDaily(text: string): void
  readRecentDaily(): string | undefined

  // MEMORY.md
  readMemoryFile(): string | undefined
  writeMemoryFile(content: string): void

  // Limits — truncate oversized curated files (SOUL/USER/MEMORY/HEARTBEAT) on disk
  enforceMdLimits(): void
}
