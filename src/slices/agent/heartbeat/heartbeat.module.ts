import type { HeartbeatHandler } from "./domain/heartbeat.service"
import { HeartbeatService } from "./domain/heartbeat.service"
import { HeartbeatGateway } from "./data/heartbeat.gateway"
import { createLogger } from "../../setup/logger"

const DEFAULT_PROMPT = `Read .agent/HEARTBEAT.md if it exists. Follow it strictly. Do not infer or repeat old tasks from prior context. If nothing needs attention, reply HEARTBEAT_OK.`

const log = createLogger("heartbeat")

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30 * 60 * 1000

/**
 * Guard for config-sourced intervals: agent.config.json values pass through
 * unvalidated, and a 0/negative interval would tick continuously — the exact
 * cost runaway this module is supposed to prevent.
 */
export function resolveIntervalMs(candidate: number | undefined): number {
  if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
    return candidate
  }
  if (candidate !== undefined) {
    log.warn(`invalid heartbeat interval (${String(candidate)}), falling back to ${DEFAULT_HEARTBEAT_INTERVAL_MS / 60000}min`)
  }
  return DEFAULT_HEARTBEAT_INTERVAL_MS
}

export class HeartbeatModule {
  private service: HeartbeatService
  private handler?: HeartbeatHandler
  private interval?: ReturnType<typeof setInterval>
  private intervalMs: number

  constructor(
    private agentDir: string,
    intervalMs?: number,
    private prompt = DEFAULT_PROMPT,
  ) {
    this.intervalMs = resolveIntervalMs(intervalMs)
    this.service = new HeartbeatService(new HeartbeatGateway(agentDir))
  }

  onHeartbeat(handler: HeartbeatHandler): void {
    this.handler = handler
  }

  start(): void {
    setTimeout(() => this.run(), 5000)
    this.interval = setInterval(() => this.run(), this.intervalMs)
    log.info(`started, interval=${this.intervalMs / 60000}min`)
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval)
  }

  private run(): void {
    if (!this.handler) return
    this.service.tick(this.prompt, this.handler).catch(err =>
      log.error("tick error", err)
    )
  }
}
