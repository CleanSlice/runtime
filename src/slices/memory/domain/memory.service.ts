import type { IMemoryGateway } from "./memory.gateway"
import type { MemoryEntry } from "./memory.types"

export class MemoryService {
  constructor(private gateway: IMemoryGateway) {}

  insert(entry: MemoryEntry): void {
    this.gateway.insert(entry)
  }

  search(query: string): MemoryEntry[] {
    return this.gateway.search(query)
  }
}
