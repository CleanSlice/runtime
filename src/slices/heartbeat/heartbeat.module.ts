import type { HeartbeatConfig } from "./domain/heartbeat.types"
import { HeartbeatService } from "./domain/heartbeat.service"
import { HeartbeatGateway } from "./data/heartbeat.gateway"

const DEFAULT_PROMPT = `Read .agent/HEARTBEAT.md if it exists. Follow it strictly. Do not infer or repeat old tasks from prior context. If nothing needs attention, reply HEARTBEAT_OK.`

export class HeartbeatModule {
  private interval?: ReturnType<typeof setInterval>
  private handler?: (message: string, to?: string, channel?: string) => Promise<void>
  private service: HeartbeatService
  private config: HeartbeatConfig

  constructor(agentDir: string, intervalMs = 30 * 60 * 1000, prompt = DEFAULT_PROMPT) {
    this.config = { agentDir, intervalMs, prompt }
    const gateway = new HeartbeatGateway(agentDir)
    this.service = new HeartbeatService(gateway)
  }

  onHeartbeat(handler: (message: string, to?: string, channel?: string) => Promise<void>): void {
    this.handler = handler
  }

  start(): void {
    setTimeout(() => this.tick(), 5000)
    this.interval = setInterval(() => this.tick(), this.config.intervalMs)
  }

  private async tick(): Promise<void> {
    const shouldRun = await this.service.shouldRun()
    if (!shouldRun) {
      console.log(`[heartbeat] no HEARTBEAT.md found at ${this.config.agentDir}`)
      return
    }
    console.log(`[heartbeat] tick — running`)
    const prompt = await this.service.getPrompt(this.config.prompt)
    await this.handler?.(prompt)
    console.log(`[heartbeat] started, interval=${this.config.intervalMs / 60000}min, agentDir=${this.config.agentDir}`)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }
}
