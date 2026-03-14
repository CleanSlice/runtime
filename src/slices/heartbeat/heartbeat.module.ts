import { existsSync } from "fs"

const HEARTBEAT_PROMPT = `Read .agent/HEARTBEAT.md if it exists. Follow it strictly. Do not infer or repeat old tasks from prior context. If nothing needs attention, reply HEARTBEAT_OK.`

export class HeartbeatModule {
  private interval?: ReturnType<typeof setInterval>
  private handler?: (message: string, to?: string, channel?: string) => Promise<void>
  private agentDir: string
  private intervalMs: number

  constructor(agentDir: string, intervalMs = 30 * 60 * 1000) {
    this.agentDir = agentDir
    this.intervalMs = intervalMs
  }

  onHeartbeat(handler: (message: string, to?: string, channel?: string) => Promise<void>): void {
    this.handler = handler
  }

  start(): void {
    // Also run once at startup after a short delay
    setTimeout(() => this.tick(), 5000)

    this.interval = setInterval(() => this.tick(), this.intervalMs)
  }

  private async tick(): Promise<void> {
    const heartbeatFile = `${this.agentDir}/HEARTBEAT.md`
    if (!existsSync(heartbeatFile)) {
      console.log(`[heartbeat] no HEARTBEAT.md found at ${heartbeatFile}`)
      return
    }
    console.log(`[heartbeat] tick — running`)
    await this.handler?.(HEARTBEAT_PROMPT)

    console.log(`[heartbeat] started, interval=${this.intervalMs / 60000}min, agentDir=${this.agentDir}`)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }
}
