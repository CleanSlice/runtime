import type { ITask } from "./task.types"

export type Task = ITask

export type DispatchDecision =
  | { kind: "new" }
  | { kind: "join"; task: Task }
  | { kind: "ask"; question: string }

export interface ITaskGateway {
  start(sessionId: string, label: string, fn: (task: Task) => Promise<void>): Task
  inject(taskId: string, text: string): boolean
  cancel(taskId: string): boolean
  cancelAll(sessionId: string): number
  get(taskId: string): Task | undefined
  getTasksBySessionId(sessionId: string): Task[]
  getRunningBySessionId(sessionId: string): Task[]
  dispatch(sessionId: string, text: string): DispatchDecision
}
