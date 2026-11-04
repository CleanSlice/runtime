import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { IMemoryLimitReport, MemoryLimits } from "../../../domain/memory.types"
import { DEFAULT_MEMORY_LIMITS, MEMORY_FILE_LIMITS } from "../../../domain/memory.types"
import { truncateOldest, truncateKeepingRules } from "../../../domain/curatedBound"

// The bounding helpers moved to the domain (CLEAN-207) so the prompt builder
// can fit a curated file without this repository touching the disk.
export { truncateKeepingRules, RULES_HEADING_RE } from "../../../domain/curatedBound"
export type { ITruncationResult } from "../../../domain/curatedBound"

const DAILY_NOISE_RE = /^\s*(HEARTBEAT_OK|HEARTBEAT_FAIL.*|\[heartbeat\].*)\s*$/i

function stripDailyNoise(text: string): string {
  return text
    .split("\n")
    .filter(line => !DAILY_NOISE_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

export type { IMemoryLimitReport }

export class FileRepository {
  private agentDir: string
  private limits: MemoryLimits

  constructor(agentDir: string, limits: MemoryLimits = DEFAULT_MEMORY_LIMITS) {
    this.agentDir = agentDir
    this.limits = limits
  }

  appendDaily(text: string): void {
    const dir = this.memoryDir()
    mkdirSync(dir, { recursive: true })
    const path = this.dailyPath(new Date())
    appendFileSync(path, text.endsWith("\n") ? text : text + "\n", "utf-8")

    // Keep the day's file within budget — drop the oldest entries if needed.
    const current = readFileSync(path, "utf-8")
    const trimmed = truncateOldest(current, this.limits.daily)
    if (trimmed !== current) {
      writeFileSync(path, trimmed)
    }
  }

  readRecentDaily(): string | undefined {
    const today = new Date()
    const yesterday = new Date(today.getTime() - 86_400_000)
    const parts: string[] = []

    for (const date of [yesterday, today]) {
      const path = this.dailyPath(date)
      if (!existsSync(path)) continue
      try {
        const raw = readFileSync(path, "utf-8")
        const content = stripDailyNoise(raw).trim()
        if (content) {
          parts.push(`### ${this.dateStr(date)}\n${content}`)
        }
      } catch {
        // skip
      }
    }

    return parts.length > 0 ? parts.join("\n\n") : undefined
  }

  readMemoryFile(): string | undefined {
    const path = join(this.agentDir, "MEMORY.md")
    try {
      return readFileSync(path, "utf-8")
    } catch {
      return undefined
    }
  }

  writeMemoryFile(content: string): void {
    const path = join(this.agentDir, "MEMORY.md")
    writeFileSync(path, truncateOldest(content, this.limits.memory))
  }

  /**
   * Enforce per-file character limits on the curated memory files
   * (SOUL.md, USER.md, MEMORY.md, HEARTBEAT.md). Oversized files are
   * truncated on disk so every consumer — the SQLite search index and the
   * system-prompt builder — sees the bounded version. Called once at load.
   */
  /**
   * Which curated files exceed their limit, and by how much — read-only
   * (CLEAN-207). Nothing is written back: the file on disk stays the
   * operator's whole text, and the prompt builder fits its own copy
   * (`boundCurated`). `chars` is the size on disk.
   */
  enforceMdLimits(): IMemoryLimitReport[] {
    const reports: IMemoryLimitReport[] = []
    for (const [filename, limitKey] of Object.entries(MEMORY_FILE_LIMITS)) {
      const path = join(this.agentDir, filename)
      if (!existsSync(path)) continue
      try {
        const current = readFileSync(path, "utf-8")
        const limit = this.limits[limitKey]
        const result = truncateKeepingRules(current, limit)
        if (result.dropped > 0 || result.over) {
          reports.push({ file: filename, limit, chars: current.length, over: result.over, dropped: result.dropped })
        }
      } catch {
        // file unreadable — skip, load() will handle absence gracefully
      }
    }
    return reports
  }

  private memoryDir(): string {
    return join(this.agentDir, "memory")
  }

  private dailyPath(date: Date): string {
    return join(this.memoryDir(), `${this.dateStr(date)}.md`)
  }

  private dateStr(date: Date): string {
    return date.toISOString().slice(0, 10)
  }
}
