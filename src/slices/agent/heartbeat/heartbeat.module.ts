import type { HeartbeatHandler } from "./domain/heartbeat.service"
import { HeartbeatService } from "./domain/heartbeat.service"
import { HeartbeatGateway } from "./data/heartbeat.gateway"

const DEFAULT_PROMPT = `Read .agent/HEARTBEAT.md if it exists. Follow it strictly. Do not infer or repeat old tasks from prior context. If nothing needs attention, reply HEARTBEAT_OK.`

export class HeartbeatModule {
  private service: HeartbeatService
  private handler?: HeartbeatHandler
  private interval?: ReturnType<typeof setInterval>

  constructor(
    private agentDir: string,
    private intervalMs = 30 * 60 * 1000,
    private prompt = DEFAULT_PROMPT,
  ) {
    this.service = new HeartbeatService(new HeartbeatGateway(agentDir))
  }

  onHeartbeat(handler: HeartbeatHandler): void {
    this.handler = handler
  }

  start(): void {
    setTimeout(() => this.run(), 5000)
    this.interval = setInterval(() => this.run(), this.intervalMs)
    console.log(`[heartbeat] started, interval=${this.intervalMs / 60000}min`)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }

  private run(): void {
    if (!this.handler) return
    this.service.tick(this.prompt, this.handler).catch(err =>
      console.error("[heartbeat] tick error:", err)
    )
  }
}
