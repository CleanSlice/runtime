import type { MemoryEntry } from "./domain/memory.types"
import { MemoryService } from "./domain/memory.service"
import { MemoryGateway } from "./data/memory.gateway"

export class MemoryModule {
  private service: MemoryService

  constructor(private agentDir: string) {
    this.service = new MemoryService(new MemoryGateway(agentDir))
  }

  async load(): Promise<void> {
    await this.service.load(this.agentDir)
  }

  search(query: string): MemoryEntry[] {
    return this.service.search(query)
  }

  insert(entry: MemoryEntry): void {
    this.service.insert(entry)
  }
}
