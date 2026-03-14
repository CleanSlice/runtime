import type { MemoryEntry } from "./memory.types"

export interface MemoryGateway {
  insert(entry: MemoryEntry): void
  search(query: string): MemoryEntry[]
}
