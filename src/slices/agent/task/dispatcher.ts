import type { TaskManager, Task } from "./task.manager"

export type DispatchDecision =
  | { kind: "new" }                    // create new task
  | { kind: "join"; task: Task }       // attach to existing task
  | { kind: "ask"; question: string }  // unclear — ask user

/**
 * Decides which task a new user message belongs to.
 *
 * Rules:
 * 1. No running tasks → new task
 * 2. One running task + message looks like a continuation → join it
 * 3. Message looks independent → new task
 * 4. Ambiguous → ask
 */
export class Dispatcher {

  constructor(private tasks: TaskManager) {}

  dispatch(sessionId: string, text: string): DispatchDecision {
    const running = this.tasks.getRunning(sessionId)

    // No active tasks — always new
    if (running.length === 0) return { kind: "new" }

    const trimmed = text.trim().toLowerCase()

    // Explicit task control commands → handled before dispatcher
    // (these are already handled in runtime.ts: /tasks, /cancel)

    // Strong "new task" signals — clearly unrelated to current tasks
    if (this.isIndependentQuery(trimmed)) {
      return { kind: "new" }
    }

    // Strong "continuation" signals
    if (running.length === 1) {
      if (this.isContinuation(trimmed, running[0])) {
        return { kind: "join", task: running[0] }
      }
    }

    // Multiple tasks running + message is short/ambiguous → ask
    if (running.length > 1 && trimmed.length < 60) {
      const taskList = running
        .map((t, i) => `${i + 1}. ${t.label}`)
        .join("\n")
      return {
        kind: "ask",
        question: `К какой задаче это относится?\n\n${taskList}\n\nОтветь цифрой или "новая задача".`,
      }
    }

    // Default: new task
    return { kind: "new" }
  }

  private isIndependentQuery(text: string): boolean {
    const independentPatterns = [
      // Question words
      /^(какая|какой|какое|сколько|где|когда|почему|как|что такое|кто|чем)/,
      /^(what|who|where|when|why|how|which)\b/i,
      // Topic keywords that signal new subject
      /погод[аеуи]/,
      /котор[ыйаяое]\s+час/,
      /сколько стоит/,
      /объясни\b/,
      /расскажи\b/,
      /помог[иай]\b/,
      /проверь\b/,
      /открой\b/,
      /зайди\b/,
      /залогин/,
      /инстаграм|instagram/i,
      /телеграм|telegram/i,
      /upwork/i,
      /написали|написал\b/,
      /сообщени[яе]/,
      /скачай|загрузи|отправь|напиши/,
    ]
    return independentPatterns.some(p => p.test(text))
  }

  private isContinuation(text: string, task: Task): boolean {
    // Only clearly continuation patterns - be conservative
    const continuationPatterns = [
      /^(да|нет|окей|ок|хорошо|понял|продолжай|подожди)$/i,
      /^(yes|no|ok|okay|continue|wait|go ahead)$/i,
      /^(повтори|попробуй ещё раз|retry)$/i,
      // Credentials/input for ongoing task
      /^(логин|пароль|email|username|code|код)[\s:]/i,
    ]

    // Check if message references keywords from task label
    const taskKeywords = task.label.toLowerCase().split(/\s+/).filter(w => w.length > 4)
    const hasTaskKeyword = taskKeywords.some(kw => text.includes(kw))

    // Only join if explicit continuation OR directly references task topic
    // Never join based purely on short length
    return continuationPatterns.some(p => p.test(text)) || hasTaskKeyword
  }
}
