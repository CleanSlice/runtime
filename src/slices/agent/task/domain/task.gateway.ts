import type { ITask, ITaskStartOptions } from "./task.types"

export type Task = ITask

export interface ITaskGateway {
  start(sessionId: string, label: string, fn: (task: Task) => Promise<void>, options?: ITaskStartOptions): Task
  inject(taskId: string, text: string): boolean
  cancel(taskId: string): boolean
  cancelAll(sessionId: string): number
  get(taskId: string): Task | undefined
  getTasksBySessionId(sessionId: string): Task[]
  getRunningBySessionId(sessionId: string): Task[]
  /** Tasks started with `parentTaskId` = this id, any status. */
  getChildren(parentTaskId: string): Task[]
}
