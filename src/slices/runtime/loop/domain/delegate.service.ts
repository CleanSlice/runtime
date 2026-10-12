import { randomUUID } from "crypto"
import type { Event } from "../../../setup/event"
import type { TaskManager, Task } from "../../../agent/task/domain/task.service"
import { isDelegateBlocked, type IDelegateRequest, type IDelegateResult } from "../../../agent/task/domain/delegate.types"
import type { ILoopContext, ILoopResult } from "./loop.types"
import { createLogger } from "../../../setup/logger"

const log = createLogger("delegate")

export interface IDelegateConfig {
  timeoutMs: number
  maxParallel: number
  summaryChars: number
}

/** The slice of LoopService a worker needs: run a context to completion. */
export interface IWorkerRunner {
  run(ctx: ILoopContext): Promise<ILoopResult>
}

export interface IDelegateDeps {
  tasks: TaskManager
  loop: IWorkerRunner
  config: IDelegateConfig
}

/**
 * Delegation with a completion contract (CLEAN-150 US6). Each request runs
 * as an internal child task with a fresh history, the parent's tools minus
 * everything that reaches outside the conversation, and a time budget.
 * Independent requests run concurrently (bounded by `maxParallel`); the
 * parent gets one summary per worker and nothing else leaves the worker.
 */
export class DelegateService {
  constructor(private deps: IDelegateDeps) {}

  async run(parent: ILoopContext, requests: IDelegateRequest[]): Promise<IDelegateResult[]> {
    const limit = Math.max(1, this.deps.config.maxParallel)
    const results: IDelegateResult[] = []
    for (let i = 0; i < requests.length; i += limit) {
      const batch = requests.slice(i, i + limit)
      const settled = await Promise.allSettled(batch.map(r => this.runOne(parent, r)))
      for (const [j, s] of settled.entries()) {
        results.push(s.status === "fulfilled"
          ? s.value
          : { goal: batch[j]!.goal, status: "error", summary: String((s.reason as Error)?.message ?? s.reason), truncated: false, taskId: "", elapsedMs: 0 })
      }
    }
    return results
  }

  private runOne(parent: ILoopContext, req: IDelegateRequest): Promise<IDelegateResult> {
    const timeoutMs = Math.min(req.timeoutMs ?? this.deps.config.timeoutMs, 3 * this.deps.config.timeoutMs)
    const started = Date.now()
    const label = `worker: ${req.goal.slice(0, 50)}`

    return new Promise<IDelegateResult>((resolve) => {
      let task: Task | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (status: IDelegateResult["status"], text: string) => {
        if (timer) clearTimeout(timer)
        const { summary, truncated } = this.cut(text)
        resolve({ goal: req.goal, status, summary, truncated, taskId: task?.id ?? "", elapsedMs: Date.now() - started })
      }

      task = this.deps.tasks.start(parent.sessionId, label, async (t) => {
        timer = setTimeout(() => {
          t.controller.abort()
          finish("timeout", `Worker exceeded its ${Math.round(timeoutMs / 1000)}s budget. Partial output: ${collected.join(" ").slice(0, 500)}`)
        }, timeoutMs)
        const collected: string[] = []
        try {
          const result = await this.deps.loop.run(this.workerContext(parent, t, req, collected))
          if (t.controller.signal.aborted) {
            finish(t.status === "cancelled" ? "cancelled" : "timeout", collected.join(" "))
            return
          }
          finish("done", result.text || collected.join("\n"))
        } catch (err) {
          finish(t.controller.signal.aborted ? "cancelled" : "error", (err as Error).message)
        }
      }, { internal: true, parentTaskId: parent.task.id })
      log.info(`started worker ${task.id.slice(0, 6)} for parent ${parent.task.id.slice(0, 6)}: ${req.goal.slice(0, 60)}`)
    })
  }

  /** A fresh history, the parent's identity, the allowed tools, and no way to reach the person. */
  private workerContext(parent: ILoopContext, task: Task, req: IDelegateRequest, collected: string[]): ILoopContext {
    const goal: Event = {
      id: randomUUID(),
      type: "user",
      ts: Date.now(),
      data: {
        text:
          `You are a delegated worker. Complete this sub-task and reply with a concise summary of the result — ` +
          `the parent agent will read it; nobody else will. Do not address the person, do not promise follow-ups.\n\n` +
          `GOAL: ${req.goal}${req.context ? `\n\nCONTEXT:\n${req.context}` : ""}`,
        from: parent.from,
      },
      taskId: task.id,
    }
    return {
      task,
      sessionId: parent.sessionId,
      agentDir: parent.agentDir,
      from: parent.from,
      ...(parent.user ? { user: parent.user } : {}),
      channel: "internal",
      isInternal: true,
      worker: true,
      systemPrompt: parent.systemPrompt,
      history: [goal],
      tools: parent.tools.filter(t => !isDelegateBlocked(t.name)),
      send: async (text) => { collected.push(text) },
      streamSend: async () => undefined,
      agentConfig: parent.agentConfig,
      reloadSkills: parent.reloadSkills,
      access: parent.access,
      isAdmin: parent.isAdmin,
      channels: parent.channels,
      turn: parent.turn,
    }
  }

  private cut(text: string): { summary: string; truncated: boolean } {
    const max = this.deps.config.summaryChars
    const clean = text.trim()
    return clean.length > max ? { summary: clean.slice(0, max - 1).trimEnd() + "…", truncated: true } : { summary: clean, truncated: false }
  }
}
