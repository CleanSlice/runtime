import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { IUsageGateway } from "../domain/usage.gateway"
import type { IDailyUsage } from "../domain/usage.types"

export class UsageGateway extends IUsageGateway {
  private filePath: string
  private apiUrl: string
  private apiKey: string

  constructor(agentDir: string) {
    super()
    const dataDir = join(agentDir, "data")
    mkdirSync(dataDir, { recursive: true })
    this.filePath = join(dataDir, "usage.json")
    this.apiUrl = process.env.API_URL ?? ""
    this.apiKey = process.env.INTERNAL_API_KEY ?? ""
  }

  load(): IDailyUsage | null {
    if (!existsSync(this.filePath)) return null
    try {
      return JSON.parse(readFileSync(this.filePath, "utf-8")) as IDailyUsage
    } catch {
      return null
    }
  }

  save(usage: IDailyUsage): void {
    try {
      writeFileSync(this.filePath, JSON.stringify(usage, null, 2))
    } catch (err) {
      console.error("[usage] failed to save usage.json:", err)
    }
  }

  async report(botId: string, usage: IDailyUsage): Promise<void> {
    if (!this.apiUrl || !botId) {
      console.warn("[usage] API_URL or BOT_ID not set, skipping report")
      return
    }

    const url = `${this.apiUrl}/internal/bots/${botId}/usage`
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-api-key": this.apiKey,
      },
      body: JSON.stringify({
        date: usage.date,
        totalInputTokens: usage.totalInputTokens,
        totalOutputTokens: usage.totalOutputTokens,
        totalCallCount: usage.totalCallCount,
        byCredential: usage.byCredential,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`API error ${res.status}: ${text.slice(0, 200)}`)
    }
  }
}
