import type { ILastTurnStats } from "../../../setup/llm/domain/resource.types"

/**
 * Per-session "how did the previous LLM turn go" state. The loop records on
 * every call; RuntimeService.buildPrompt consumes (get + delete) at the start
 * of the next turn to decide whether to inject the resource-status hint.
 *
 * In-memory by design — this is ephemeral telemetry, not durable usage.
 */
export class LastTurnStatsTracker {
  private map = new Map<string, ILastTurnStats>()

  record(sessionId: string, stats: ILastTurnStats): void {
    this.map.set(sessionId, stats)
  }

  get(sessionId: string): ILastTurnStats | undefined {
    return this.map.get(sessionId)
  }

  /**
   * "Delayed" if ANY of:
   * - elapsed > 30s wall-clock
   * - withRetry produced at least one retry
   * - a 429 was observed
   * - an overloaded_error was observed
   *
   * 30s is well above healthy Claude latency (3–15s) so we don't spam the
   * hint on every normal turn.
   */
  wasDelayed(sessionId: string): boolean {
    const s = this.map.get(sessionId)
    if (!s) return false
    return s.elapsedMs > 30_000 || s.retries > 0 || s.rateLimited || s.overloaded
  }

  /** One-shot: returns the stats and removes them so the hint fires once. */
  consume(sessionId: string): ILastTurnStats | undefined {
    const s = this.map.get(sessionId)
    if (s) this.map.delete(sessionId)
    return s
  }
}
