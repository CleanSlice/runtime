import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import type { IMemoryLimitReport, MemoryLimits } from "../../../domain/memory.types"
import { DEFAULT_MEMORY_LIMITS, MEMORY_FILE_LIMITS } from "../../../domain/memory.types"

const DAILY_NOISE_RE = /^\s*(HEARTBEAT_OK|HEARTBEAT_FAIL.*|\[heartbeat\].*)\s*$/i

function stripDailyNoise(text: string): string {
  return text
    .split("\n")
    .filter(line => !DAILY_NOISE_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

/**
 * Truncate `content` to `limit` characters by dropping whole lines from the
 * TOP (oldest content) until the remainder fits. A marker line is prepended so
 * the agent can see truncation happened. Returns `content` unchanged when it
 * already fits. A single oversized line is hard-sliced, keeping its tail.
 */
function truncateOldest(content: string, limit: number): string {
  if (content.length <= limit) return content

  const marker = `<!-- [memory] older content truncated to fit ${limit}-char limit -->`
  const budget = Math.max(0, limit - marker.length - 1)

  const lines = content.split("\n")
  while (lines.length > 1 && lines.join("\n").length > budget) {
    lines.shift()
  }

  let body = lines.join("\n")
  if (body.length > budget) {
    body = body.slice(body.length - budget)  // keep the newest characters
  }
  return `${marker}\n${body}`
}

/** The one section of an identity file that is never dropped to fit a limit (CLEAN-150 US2). */
export const RULES_HEADING_RE = /^## rules\b/i

export interface ITruncationResult {
  text: string
  /** True when the protected rules alone exceed the limit — nothing more could be dropped. */
  over: boolean
  /** Characters removed from the non-protected content. */
  dropped: number
}

/**
 * Fit `content` into `limit` characters without touching the `## Rules`
 * section: everything else is truncated oldest-first (as `truncateOldest`),
 * then the rules are appended whole. When the rules by themselves exceed the
 * limit they are still kept and `over` is reported, so an operator sees the
 * overflow instead of losing a rule silently.
 */
export function truncateKeepingRules(content: string, limit: number): ITruncationResult {
  if (content.length <= limit) return { text: content, over: false, dropped: 0 }

  const lines = content.split("\n")
  const start = lines.findIndex(l => RULES_HEADING_RE.test(l))
  if (start === -1) {
    const text = truncateOldest(content, limit)
    return { text, over: false, dropped: content.length - text.length }
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) { end = i; break }
  }
  const rules = lines.slice(start, end).join("\n").trimEnd()
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim()

  // Two newlines join the parts and one closes the file.
  const budgetForRest = limit - rules.length - 3
  if (budgetForRest <= 0) {
    return { text: rules + "\n", over: true, dropped: rest.length }
  }
  const kept = truncateOldest(rest, budgetForRest)
  const text = kept ? `${kept}\n\n${rules}\n` : rules + "\n"
  return { text, over: false, dropped: rest.length - kept.length }
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
  enforceMdLimits(): IMemoryLimitReport[] {
    const reports: IMemoryLimitReport[] = []
    for (const [filename, limitKey] of Object.entries(MEMORY_FILE_LIMITS)) {
      const path = join(this.agentDir, filename)
      if (!existsSync(path)) continue
      try {
        const current = readFileSync(path, "utf-8")
        const limit = this.limits[limitKey]
        // The rules of an identity file survive the cut; reference material goes first.
        const result = truncateKeepingRules(current, limit)
        if (result.text !== current) {
          writeFileSync(path, result.text)
        }
        if (result.dropped > 0 || result.over) {
          reports.push({ file: filename, limit, chars: result.text.length, over: result.over, dropped: result.dropped })
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
