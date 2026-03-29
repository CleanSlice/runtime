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

  /** Append to today's daily memory file */
  appendDaily(text: string): void {
    MemoryService.appendDaily(this.agentDir, text)
  }

  /** Read today + yesterday daily files for system prompt */
  readRecentDaily(): string | undefined {
    return MemoryService.readRecentDaily(this.agentDir)
  }
}
