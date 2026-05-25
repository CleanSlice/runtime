import type { ILastTurnStats } from "../../../../setup/llm/domain/resource.types"

/**
 * Build a one-time hint injected into the system prompt of the NEXT turn
 * after a turn that was delayed by retries / rate-limits / overload. Tells
 * the agent it can call `resource_status` to inspect operating state.
 */
export function buildResourceHintPrompt(s: ILastTurnStats): string {
  const secs = Math.round(s.elapsedMs / 1000)
  const flags = [
    s.retries > 0 ? `retries=${s.retries}` : null,
    s.rateLimited ? "rate-limited" : null,
    s.overloaded ? "overloaded" : null,
  ].filter(Boolean).join(", ")
  const tail = flags ? ` (${flags})` : ""
  return (
    `# Resource Notice\n\n` +
    `Your previous turn took ${secs}s${tail}. If you suspect resource pressure ` +
    `(slow responses, rate limits, low memory), call the \`resource_status\` ` +
    `tool to check token headroom, credential cooldowns, and system memory ` +
    `before continuing. This notice will not repeat unless another slow turn occurs.`
  )
}
