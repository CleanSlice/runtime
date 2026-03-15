export interface Task {
  id: string
  label: string
  sessionId: string   // user session (e.g. telegram:55212224)
  taskSessionId: string  // kept for compat but no longer used for isolation
  startedAt: number
  status: "running" | "done" | "error" | "cancelled"
  controller: AbortController
  // Queue of extra user messages injected while task is running
  inbox: string[]
}

export class TaskManager {
  private tasks = new Map<string, Task>()

  /**
   * Register and fire a background task.
   * `fn` receives an AbortSignal — it should check signal.aborted periodically.
   * Returns taskId immediately.
   */
  start(
    sessionId: string,
    label: string,
    fn: (task: Task) => Promise<void>
  ): Task {
    const { randomUUID } = require("crypto") as typeof import("crypto")
    const id = randomUUID()
    const taskSessionId = `${sessionId}:task:${id}`
    const controller = new AbortController()

    const task: Task = {
      id,
      label,
      sessionId,
      taskSessionId,
      startedAt: Date.now(),
      status: "running",
      controller,
      inbox: [],
    }

    this.tasks.set(id, task)

    // Fire and forget — do NOT await
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
        // Clean up after 10 minutes
        setTimeout(() => this.tasks.delete(id), 10 * 60 * 1000)
      })

    return task
  }

  /** Inject a user message into a running task's inbox */
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

  getForSession(sessionId: string): Task[] {
    return Array.from(this.tasks.values()).filter(t => t.sessionId === sessionId)
  }

  getRunning(sessionId: string): Task[] {
    return this.getForSession(sessionId).filter(t => t.status === "running")
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId)
  }

  formatList(sessionId: string): string {
    const tasks = this.getForSession(sessionId)
    if (tasks.length === 0) return "Нет активных задач."
    return tasks
      .map(t => {
        const elapsed = Math.round((Date.now() - t.startedAt) / 1000)
        const icon = { running: "⏳", done: "✅", error: "❌", cancelled: "🚫" }[t.status]
        return `${icon} [${t.id.slice(0, 6)}] ${t.label} — ${elapsed}s`
      })
      .join("\n")
  }
}
