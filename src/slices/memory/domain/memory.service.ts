import type { MemoryGateway } from "./memory.gateway"
import type { MemoryEntry } from "./memory.types"

export class MemoryService {
  constructor(private gateway: MemoryGateway) {}

  insert(entry: MemoryEntry): void {
    this.gateway.insert(entry)
  }

  search(query: string): MemoryEntry[] {
    return this.gateway.search(query)
  }
}
