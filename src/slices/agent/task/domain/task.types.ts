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
}
