import type { IMemoryGateway } from "./memory.gateway"
import type { MemoryEntry } from "./memory.types"
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs"
import { join } from "path"

const MD_FILES = ["SOUL.md", "USER.md", "MEMORY.md", "HEARTBEAT.md"]

export class MemoryService {
  constructor(private gateway: IMemoryGateway) {}

  async load(agentDir: string): Promise<void> {
    for (const file of MD_FILES) {
      const path = `${agentDir}/${file}`
      if (!existsSync(path)) continue
      const content = await Bun.file(path).text()
      this.gateway.insert({ id: file, content, source: file, ts: Date.now() })
    }
  }

  insert(entry: MemoryEntry): void {
    this.gateway.insert(entry)
  }

  search(query: string): MemoryEntry[] {
    return this.gateway.search(query)
  }

  // ─── Daily memory files ─────────────────────────────────────────────────

  private static dateStr(date: Date): string {
    return date.toISOString().slice(0, 10)
  }

  private static memoryDir(agentDir: string): string {
    return join(agentDir, "memory")
  }

  private static dailyPath(agentDir: string, date: Date): string {
    return join(MemoryService.memoryDir(agentDir), `${MemoryService.dateStr(date)}.md`)
  }

  /** Append a line to today's daily memory file */
  static appendDaily(agentDir: string, text: string): void {
    const dir = MemoryService.memoryDir(agentDir)
    mkdirSync(dir, { recursive: true })
    const path = MemoryService.dailyPath(agentDir, new Date())
    appendFileSync(path, text.endsWith("\n") ? text : text + "\n", "utf-8")
  }

  /** Read today + yesterday daily memory files for injection into system prompt */
  static readRecentDaily(agentDir: string): string | undefined {
    const today = new Date()
    const yesterday = new Date(today.getTime() - 86_400_000)
    const parts: string[] = []

    for (const date of [yesterday, today]) {
      const path = MemoryService.dailyPath(agentDir, date)
      if (!existsSync(path)) continue
      try {
        const content = readFileSync(path, "utf-8").trim()
        if (content) {
          parts.push(`### ${MemoryService.dateStr(date)}\n${content}`)
        }
      } catch {
        // skip
      }
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined
  }
}
