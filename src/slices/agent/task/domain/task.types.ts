export type TaskStatus = "running" | "done" | "error" | "cancelled"

export interface ITask {
  id: string
  label: string
  sessionId: string
  taskSessionId: string
  startedAt: number
  status: TaskStatus
  controller: AbortController
  inbox: string[]
  /** System-initiated task (crash recovery, cron, heartbeat) — hidden from the user-facing router. */
  internal: boolean
}
