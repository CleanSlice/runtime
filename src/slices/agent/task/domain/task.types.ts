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
  /** Set on delegated workers: the task whose turn is waiting on this one (CLEAN-150 US6). */
  parentTaskId?: string
}

export interface ITaskStartOptions {
  internal?: boolean
  parentTaskId?: string
}
