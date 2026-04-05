import type { ITaskGateway, Task, DispatchDecision } from "./task.gateway"

export type { Task, DispatchDecision }

export class TaskManager {
  constructor(private gateway: ITaskGateway) {}

  /** Register and fire a background task. Used by RuntimeService to execute each user message. */
  start(sessionId: string, label: string, fn: (task: Task) => Promise<void>): Task {
    return this.gateway.start(sessionId, label, fn)
  }

  /** Push a follow-up message into a running task's inbox. Used by BotService on "join" dispatch. */
  inject(taskId: string, text: string): boolean {
    return this.gateway.inject(taskId, text)
  }

  /** Cancel a single task by id. Used by /cancel command. */
  cancel(taskId: string): boolean {
    return this.gateway.cancel(taskId)
  }

  /** Cancel all running tasks for a session. Used by stop phrases ("stop", "abort", etc.). */
  cancelAll(sessionId: string): number {
    return this.gateway.cancelAll(sessionId)
  }

  /** Look up a task by id. Used by /cancel to verify task ownership. */
  get(taskId: string): Task | undefined {
    return this.gateway.get(taskId)
  }

  /** All tasks (any status) for a session. Used by /tasks and /status commands. */
  getTasksBySessionId(sessionId: string): Task[] {
    return this.gateway.getTasksBySessionId(sessionId)
  }

  /** Currently running tasks for a session. Used by dispatch to decide join vs new. */
  getRunningBySessionId(sessionId: string): Task[] {
    return this.gateway.getRunningBySessionId(sessionId)
  }

  /** Route an incoming message: new task, join existing, or ask user. Used by BotService. */
  dispatch(sessionId: string, text: string): DispatchDecision {
    return this.gateway.dispatch(sessionId, text)
  }
}
