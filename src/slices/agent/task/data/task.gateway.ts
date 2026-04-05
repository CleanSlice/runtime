import type { ITaskGateway, Task, DispatchDecision } from "../domain/task.gateway"
import type { ITask } from "../domain/task.types"
import { randomUUID } from "crypto"

export class TaskGateway implements ITaskGateway {
  private tasks = new Map<string, Task>()

  start(
    sessionId: string,
    label: string,
    fn: (task: Task) => Promise<void>,
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

  dispatch(sessionId: string, text: string): DispatchDecision {
    const running = this.getRunningBySessionId(sessionId)

    if (running.length === 0) return { kind: "new" }

    const trimmed = text.trim().toLowerCase()

    if (this.isIndependentQuery(trimmed)) {
      return { kind: "new" }
    }

    if (running.length === 1) {
      if (this.isContinuation(trimmed, running[0])) {
        return { kind: "join", task: running[0] }
      }
    }

    if (running.length > 1 && trimmed.length < 60) {
      const taskList = running
        .map((t, i) => `${i + 1}. ${t.label}`)
        .join("\n")
      return {
        kind: "ask",
        question: `Which task does this relate to?\n\n${taskList}\n\nReply with a number or "new task".`,
      }
    }

    return { kind: "new" }
  }

  private isIndependentQuery(text: string): boolean {
    const independentPatterns = [
      /^(what|who|where|when|why|how|which)\b/i,
      /weather/i,
      /what time/i,
      /how much/i,
      /explain\b/i,
      /tell me\b/i,
      /help me\b/i,
      /check\b/i,
      /open\b/i,
      /go to\b/i,
      /log ?in/i,
      /instagram/i,
      /telegram/i,
      /upwork/i,
      /message[sd]?\b/i,
      /download|upload|send|write/i,
    ]
    return independentPatterns.some(p => p.test(text))
  }

  private isContinuation(text: string, task: Task): boolean {
    const continuationPatterns = [
      /^(yes|no|ok|okay|continue|wait|go ahead)$/i,
      /^(retry|try again)$/i,
      /^(login|password|email|username|code)[\s:]/i,
    ]

    const taskKeywords = task.label.toLowerCase().split(/\s+/).filter(w => w.length > 4)
    const hasTaskKeyword = taskKeywords.some(kw => text.includes(kw))

    return continuationPatterns.some(p => p.test(text)) || hasTaskKeyword
  }
}
