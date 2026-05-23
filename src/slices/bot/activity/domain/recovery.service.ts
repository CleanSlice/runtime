import type { IActivityGateway } from "./activity.gateway"
import type { IRecoveryContext } from "./activity.types"
import { SILENT_REPLY_TOKEN } from "../../../agent/agent/domain/silentReply"
import { createLogger } from "../../../setup/logger"

const log = createLogger("recovery")

/**
 * Detects tasks interrupted by a restart and builds a system-role
 * instruction that lets the agent silently decide whether to resume —
 * no user-facing "I restarted" message is emitted.
 */
export class RecoveryService {
  constructor(private gateway: IActivityGateway) {}

  /** Returns recovery context if there was an interrupted task, or null. */
  check(): IRecoveryContext | null {
    const interrupted = this.gateway.get()
    if (!interrupted) return null

    const isInternal = interrupted.channel === "internal"
    if (isInternal) {
      this.gateway.clear()
      return null
    }

    const elapsed = Math.round((Date.now() - interrupted.startedAt) / 1000)
    const elapsedStr = elapsed > 60 ? `${Math.round(elapsed / 60)}m` : `${elapsed}s`

    // Don't auto-resume stale tasks. A task interrupted long ago is almost
    // never still wanted — the user has moved on — and resuming it on boot
    // races the live conversation for shared resources (e.g. browser_play,
    // which fails fast when a second call collides with the first).
    const MAX_RESUME_AGE_S = 30 * 60
    if (elapsed > MAX_RESUME_AGE_S) {
      log.info(`interrupted task "${interrupted.label}" is ${elapsedStr} old — too stale to resume, clearing`)
      this.gateway.clear()
      return null
    }

    log.info(`interrupted task found: "${interrupted.label}" for user=${interrupted.userId} (${elapsedStr} ago, step: ${interrupted.lastStep})`)

    return {
      channel: interrupted.channel,
      userId: interrupted.userId,
      instruction:
        `[recovery] The previous task was interrupted by a restart and was not completed.\n` +
        `Original request: "${interrupted.text}"\n` +
        `Last step before interruption: ${interrupted.lastStep} (${elapsedStr} ago).\n\n` +
        `Review the recent conversation and any pending state. ` +
        `If the goal is already achieved, reply with ONLY \`${SILENT_REPLY_TOKEN}\` (the runtime suppresses this token — the user sees nothing). ` +
        `Otherwise, finish the task autonomously without announcing the restart to the user.`,
    }
  }

  clear(): void {
    this.gateway.clear()
  }
}
