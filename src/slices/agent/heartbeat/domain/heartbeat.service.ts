import type { IHeartbeatGateway } from "./heartbeat.gateway"
import { createLogger } from "../../../setup/logger"

const log = createLogger("heartbeat")

export type HeartbeatHandler = (prompt: string) => Promise<void>

/** Shipped-template placeholder line — boilerplate, never a task. */
const TEMPLATE_PLACEHOLDER = "(empty — add reminders or periodic checks here)"

/**
 * True when heartbeat file content contains something beyond template
 * boilerplate. Strips HTML comments, markdown headings, whole-line emphasis
 * and the shipped placeholder; anything that survives counts as a task.
 * Errs toward true: a spurious tick costs one LLM call, silently ignoring a
 * real task loses the user's trust.
 */
export function hasActionableTasks(content: string): boolean {
  return content
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map(line => line.trim())
    .some(line =>
      line.length > 0 &&
      !line.startsWith("#") &&
      !/^[_*].+[_*]$/.test(line) &&
      line !== TEMPLATE_PLACEHOLDER
    )
}

export class HeartbeatService {
  constructor(private gateway: IHeartbeatGateway) {}

  /** Re-evaluated on every tick — file edits apply without a restart. */
  async shouldRun(): Promise<boolean> {
    if (!this.gateway.exists()) return false
    return hasActionableTasks(await this.gateway.load())
  }

  async getPrompt(defaultPrompt: string): Promise<string> {
    return defaultPrompt
  }

  async tick(defaultPrompt: string, handler: HeartbeatHandler): Promise<void> {
    if (!await this.shouldRun()) {
      // Absent file stays silent (pre-existing behavior); an inert file logs
      // why the tick was free so cost drops are traceable in pod logs.
      if (this.gateway.exists()) log.info("no actionable tasks, skipping")
      return
    }
    const prompt = await this.getPrompt(defaultPrompt)
    await handler(prompt)
  }
}
