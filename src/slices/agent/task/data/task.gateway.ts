import type { ITaskGateway, Task } from "../domain/task.gateway"
import type { ITask } from "../domain/task.types"
import { randomUUID } from "crypto"

export class TaskGateway implements ITaskGateway {
  private tasks = new Map<string, Task>()

  start(
    sessionId: string,
    label: string,
    fn: (task: Task) => Promise<void>,
    options?: { internal?: boolean },
  ): Task {
    const id = randomUUID()
    const taskSessionId = `${sessionId}:task:${id}`
    const controller = new AbortController()

    const task: ITask = {
      id,
      label,
      sessionId,
      taskSessionId,
      startedAt: Date.now(),
      status: "running",
      controller,
      inbox: [],
      internal: options?.internal ?? false,
    }

    this.tasks.set(id, task)

    fn(task)
      .then(() => {
        task.status = "done"
      })
      .catch(err => {
        if ((err as Error)?.name === "AbortError") {
          task.status = "cancelled"
        } else {
          task.status = "error"
          console.error(`[task:${id}] error:`, err)
        }
      })
      .finally(() => {
        setTimeout(() => this.tasks.delete(id), 10 * 60 * 1000)
      })

    return task
  }

  inject(taskId: string, text: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== "running") return false
    task.inbox.push(text)
    return true
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== "running") return false
    task.controller.abort()
    task.status = "cancelled"
    return true
  }

  cancelAll(sessionId: string): number {
    const running = this.getRunningBySessionId(sessionId)
    for (const task of running) {
      task.controller.abort()
      task.status = "cancelled"
    }
    return running.length
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId)
  }

  getTasksBySessionId(sessionId: string): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.sessionId === sessionId)
  }

  getRunningBySessionId(sessionId: string): Task[] {
    return this.getTasksBySessionId(sessionId).filter(t => t.status === "running")
  }
}
