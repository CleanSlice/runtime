import type { IActivityGateway } from "./activity.gateway"
import type { IRecoveryContext } from "./activity.types"

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

    console.log(`[recovery] interrupted task found: "${interrupted.label}" for user=${interrupted.userId} (${elapsedStr} ago, step: ${interrupted.lastStep})`)

    return {
      channel: interrupted.channel,
      userId: interrupted.userId,
      instruction:
        `[recovery] The previous task was interrupted by a restart and was not completed.\n` +
        `Original request: "${interrupted.text}"\n` +
        `Last step before interruption: ${interrupted.lastStep} (${elapsedStr} ago).\n\n` +
        `Review the recent conversation and any pending state. ` +
        `If the goal is already achieved, do nothing and stay silent. ` +
        `Otherwise, finish the task autonomously without announcing the restart to the user.`,
    }
  }

  clear(): void {
    this.gateway.clear()
  }
}
