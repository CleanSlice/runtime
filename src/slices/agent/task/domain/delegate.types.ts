/** One sub-task handed to an isolated worker (CLEAN-150 US6). */
export interface IDelegateRequest {
  goal: string
  /** Facts the worker needs that are not in its fresh history. */
  context?: string
  timeoutMs?: number
}

export type DelegateStatus = "done" | "timeout" | "error" | "cancelled"

export interface IDelegateResult {
  goal: string
  status: DelegateStatus
  /** The worker's final reply, cut to `tools.delegate.summaryChars`. */
  summary: string
  truncated: boolean
  taskId: string
  elapsedMs: number
}

/**
 * Tools a worker never gets: no further delegation, no long-term memory
 * writes, no messaging the person, no changes to skills or secrets. The
 * parent owns everything that leaves the conversation.
 */
export const DELEGATE_BLOCKED = new Set<string>([
  "delegate_task",
  "spawn_agent",
  "memory_save",
  "telegram_send",
  "tts",
  "skill_write",
  "skill_delete",
  "secret_set",
  "secret_delete",
  "cron_add",
  "cron_remove",
  "cron_disable",
  "approve_user",
  "set_access_strategy",
])

/** Also blocked: every `channel_*` tool — the worker must not touch the agent's own connections. */
export function isDelegateBlocked(toolName: string): boolean {
  return DELEGATE_BLOCKED.has(toolName) || toolName.startsWith("channel_")
}

/**
 * The name list above is belt and braces; the rule that actually bounds a
 * worker is by effect: unless `tools.delegate.allowWrite` is on, a worker
 * only gets tools that observe (`effect: "read"`, or per-call tools like
 * `file`/`http` whose write calls the loop then refuses). A new or MCP tool
 * with side effects is therefore excluded by default, not by remembering to
 * list it.
 */
export function isDelegateAllowed(tool: { name: string; effect?: "read" | "write"; effectOf?: unknown }, allowWrite: boolean): boolean {
  if (isDelegateBlocked(tool.name)) return false
  if (allowWrite) return true
  return tool.effect === "read" || typeof tool.effectOf === "function"
}
