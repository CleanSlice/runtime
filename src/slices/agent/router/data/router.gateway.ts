import { randomUUID } from "crypto"
import type { LlmModule } from "../../../setup/llm/llm.module"
import type { Event } from "../../../setup/event"
import type { IRouterGateway } from "../domain/router.gateway"
import type { IPendingDisambiguation, IRouterTask, RouterDecision } from "../domain/router.types"
import { createLogger } from "../../../setup/logger"

const PENDING_TTL_MS = 5 * 60 * 1000

const log = createLogger("router")

export class RouterGateway implements IRouterGateway {
  private pending = new Map<string, IPendingDisambiguation>()

  constructor(private llm: LlmModule) {}

  async route(sessionId: string, text: string, runningTasks: IRouterTask[]): Promise<RouterDecision> {
    const trimmed = text.trim()

    const pending = this.getLivePending(sessionId)
    if (pending) {
      const resolved = this.resolvePending(trimmed, pending)
      if (resolved) {
        this.pending.delete(sessionId)
        return resolved
      }
      // Reply didn't look like an answer — drop pending and re-classify below.
      this.pending.delete(sessionId)
    }

    if (runningTasks.length === 0) return { kind: "new" }

    const classification = await this.classify(trimmed, runningTasks)

    if (classification === "new") return { kind: "new" }

    if (typeof classification === "number") {
      const task = runningTasks[classification - 1]
      if (task) return { kind: "join", taskId: task.id }
      return { kind: "new" }
    }

    // ambiguous → ask
    const question = this.buildQuestion(runningTasks)
    this.pending.set(sessionId, {
      question,
      options: runningTasks.map(t => ({ id: t.id, label: t.label })),
      askedAt: Date.now(),
    })
    return { kind: "ask", question }
  }

  clear(sessionId: string): void {
    this.pending.delete(sessionId)
  }

  private getLivePending(sessionId: string): IPendingDisambiguation | undefined {
    const p = this.pending.get(sessionId)
    if (!p) return undefined
    if (Date.now() - p.askedAt > PENDING_TTL_MS) {
      this.pending.delete(sessionId)
      return undefined
    }
    return p
  }

  private resolvePending(text: string, pending: IPendingDisambiguation): RouterDecision | null {
    const normalized = text.toLowerCase()
    if (/^(new task|new|новая|новый таск|новая задача)$/i.test(normalized)) {
      return { kind: "new" }
    }
    const numMatch = normalized.match(/^\d+$/)
    if (numMatch) {
      const num = parseInt(numMatch[0], 10)
      if (num >= 1 && num <= pending.options.length) {
        return { kind: "join", taskId: pending.options[num - 1].id }
      }
    }
    return null
  }

  private buildQuestion(tasks: IRouterTask[]): string {
    const list = tasks.map((t, i) => `${i + 1}. ${t.label}`).join("\n")
    return `Which task does this relate to?\n\n${list}\n\nReply with a number or "new task".`
  }

  private async classify(text: string, tasks: IRouterTask[]): Promise<number | "new" | "ambiguous"> {
    const taskList = tasks.map((t, i) => `${i + 1}. ${t.label}`).join("\n")
    const systemPrompt =
      `You classify user messages for a chat agent that may have several background tasks running.\n` +
      `Decide whether the new message continues one of the active tasks, starts a new unrelated topic, or is ambiguous.\n\n` +
      `Output rules — your entire reply must be exactly one of:\n` +
      `  0     — the message is a new, unrelated topic\n` +
      `  1..N  — the message continues task #N from the list\n` +
      `  ?     — genuinely ambiguous, ask the user to choose\n\n` +
      `Treat short follow-ups (yes/no/ok, single digits, codes, credentials, "retry", "повтори", "продолжи") as continuations of the most recent task unless they clearly belong elsewhere.\n` +
      `Prefer ? only when the message could reasonably belong to more than one task.`

    const userText = `Active tasks:\n${taskList}\n\nNew message: ${JSON.stringify(text)}\n\nYour answer:`
    const event: Event = {
      id: randomUUID(),
      type: "user",
      ts: Date.now(),
      data: { text: userText },
    }

    try {
      const response = await this.llm.auxComplete(systemPrompt, [event], [])
      return this.parseClassification(response.text, tasks.length)
    } catch (err) {
      log.error("classification failed, defaulting to ambiguous", err)
      return "ambiguous"
    }
  }

  private parseClassification(raw: string, taskCount: number): number | "new" | "ambiguous" {
    const trimmed = raw.trim()
    if (trimmed.startsWith("?")) return "ambiguous"
    const numMatch = trimmed.match(/^-?\d+/)
    if (!numMatch) return "ambiguous"
    const num = parseInt(numMatch[0], 10)
    if (num === 0) return "new"
    if (num >= 1 && num <= taskCount) return num
    return "ambiguous"
  }
}
