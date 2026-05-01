import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

const DAILY_NOISE_RE = /^\s*(HEARTBEAT_OK|HEARTBEAT_FAIL.*|\[heartbeat\].*)\s*$/i

function stripDailyNoise(text: string): string {
  return text
    .split("\n")
    .filter(line => !DAILY_NOISE_RE.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
}

export class FileRepository {
  private agentDir: string

  constructor(agentDir: string) {
    this.agentDir = agentDir
  }

  appendDaily(text: string): void {
    const dir = this.memoryDir()
    mkdirSync(dir, { recursive: true })
    const path = this.dailyPath(new Date())
    appendFileSync(path, text.endsWith("\n") ? text : text + "\n", "utf-8")
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
    writeFileSync(path, content)
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
