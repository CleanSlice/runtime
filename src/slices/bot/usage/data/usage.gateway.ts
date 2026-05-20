import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { IUsageGateway } from "../domain/usage.gateway"
import type { IDailyUsage } from "../domain/usage.types"
import { createLogger } from "../../../setup/logger"

const log = createLogger("usage")

/**
 * UsageGateway — local persistence + remote reporting.
 *
 * Local: data/usage.json is rewritten on every LLM call so a crashed pod
 *        leaves a recoverable snapshot. The S3 sync watcher uploads it.
 *
 * Remote: posts {date, byModel} to ranch's POST /agents/:id/usage endpoint.
 *         Ranch authenticates with `x-bridle-api-key` (BRIDLE_API_KEY env).
 *         Defaults to ranch's URL contract — set RANCH_API_URL or fall back
 *         to legacy API_URL if you're still on the old deployment shape.
 */
export class UsageGateway extends IUsageGateway {
  private filePath: string
  private apiUrl: string
  private apiKey: string

  constructor(agentDir: string) {
    super()
    const dataDir = join(agentDir, "data")
    mkdirSync(dataDir, { recursive: true })
    this.filePath = join(dataDir, "usage.json")
    // Prefer ranch convention, fall back to legacy OpenClaw env names.
    this.apiUrl = process.env.RANCH_API_URL ?? process.env.API_URL ?? ""
    this.apiKey = process.env.BRIDLE_API_KEY ?? process.env.INTERNAL_API_KEY ?? ""
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
      log.error("failed to save usage.json", err)
    }
  }

  async report(agentId: string, usage: IDailyUsage): Promise<void> {
    if (!this.apiUrl || !agentId) {
      log.warn("RANCH_API_URL/BRIDLE_AGENT_ID not set, skipping report")
      return
    }

    const url = `${this.apiUrl}/agents/${agentId}/usage`
    // ranch expects { date, byModel: { <modelName>: { inputTokens, outputTokens, callCount, llmCredentialId? } } }
    // (see ReportUsageDto in ranch/api/src/slices/usage/dtos/reportUsage.dto.ts)
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridle-api-key": this.apiKey,
      },
      body: JSON.stringify({
        date: usage.date,
        byModel: usage.byModel ?? {},
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`ranch usage report ${res.status}: ${text.slice(0, 200)}`)
    }
  }
}
