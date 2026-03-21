import type { MemoryEntry } from "./memory.types"

export interface IMemoryGateway {
  insert(entry: MemoryEntry): void
  search(query: string): MemoryEntry[]
}
