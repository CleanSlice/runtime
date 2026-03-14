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
    this.interval = setInterval(async () => {
      const heartbeatFile = `${this.agentDir}/HEARTBEAT.md`
      if (!existsSync(heartbeatFile)) return

      const prompt = HEARTBEAT_PROMPT
      await this.handler?.(prompt)
    }, this.intervalMs)

    console.log(`[heartbeat] started, interval=${this.intervalMs / 60000}min`)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }
}
