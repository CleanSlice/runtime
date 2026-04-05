import type { IActivityGateway } from "./activity.gateway"
import type { IRecoveryMessage } from "./activity.types"

/**
 * Checks for interrupted tasks on startup and builds a notification message.
 */
export class RecoveryService {
  constructor(private gateway: IActivityGateway) {}

  /** Returns a recovery message if there was an interrupted task, or null. */
  check(): IRecoveryMessage | null {
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
      message:
        `⚠️ I restarted. Was previously working on:\n\n` +
        `"${interrupted.text}"\n\n` +
        `Last step: ${interrupted.lastStep} (${elapsedStr} ago)\n\n` +
        `Want to continue?`,
    }
  }

  clear(): void {
    this.gateway.clear()
  }
}
