import type { ICommandContext, ICommandResult } from "./command.types"
import type { AccessModule } from "../../access/access.module"
import type { SkillModule } from "../../../agent/skill/skill.module"
import type { VoiceModule } from "../../voice/voice.module"
import type { TaskManager } from "../../../agent/task/domain/task.service"
import type { SessionModule } from "../../../agent/session/session.module"

interface CommandDeps {
  access: AccessModule
  skills: SkillModule
  voice: VoiceModule
  tasks: TaskManager
  session: SessionModule
}

type SendFn = (text: string) => Promise<void>

export class CommandService {
  constructor(private deps: CommandDeps) {}

  async handle(ctx: ICommandContext, send: SendFn): Promise<ICommandResult> {
    const text = ctx.text.trim()

    // /skills — list or reload skills (admin only)
    if (text === "/skills" || text === "/skills reload") {
      return this.handleSkills(ctx, text, send)
    }

    // /voice toggle
    if (text === "/voice") {
      const isNowOn = this.deps.voice.toggle(ctx.from)
      const response = isNowOn ? "🔊 Voice mode enabled" : "🔇 Voice mode disabled"
      await send(response)
      return { handled: true }
    }

    // /tasks — list active tasks
    if (text === "/tasks") {
      await send(this.formatTaskList(ctx.sessionId))
      return { handled: true }
    }

    // /cancel <id>
    const cancelMatch = text.match(/^\/cancel\s+(\S+)/)
    if (cancelMatch) {
      return this.handleCancel(ctx, cancelMatch[1], send)
    }

    // /help
    if (text === "/help") {
      await send(
        `🤖 *Available commands:*\n\n` +
        `/start — Start the agent\n` +
        `/help — Show this help\n` +
        `/status — Agent status\n` +
        `/clear — Reset current session\n` +
        `/memory — What the agent remembers about you\n` +
        `/tasks — List active tasks\n` +
        `/voice — Toggle voice mode\n` +
        `/cancel <id> — Cancel a task\n` +
        `/skills — List loaded skills\n` +
        `/skills reload — Reload skills from disk (admin only)`,
      )
      return { handled: true }
    }

    // /status
    if (text === "/status") {
      return this.handleStatus(ctx, send)
    }

    // /clear — reset session
    if (text === "/clear") {
      this.deps.session.clear(ctx.channel, ctx.from)
      await send(`✅ Session cleared. Starting fresh!`)
      return { handled: true }
    }

    // /memory — pass through to LLM
    if (text === "/memory") {
      return {
        handled: true,
        passthrough: "Please summarize what you know and remember about me from memory. Be concise.",
      }
    }

    // /start
    if (text === "/start") {
      return this.handleStart(ctx, send)
    }

    return { handled: false }
  }

  private async handleSkills(ctx: ICommandContext, text: string, send: SendFn): Promise<ICommandResult> {
    const isAdmin = this.deps.access.isAdmin(ctx.from)
    if (text === "/skills reload") {
      if (!isAdmin) {
        await send("🔒 Only admins can reload skills.")
        return { handled: true }
      }
      const skills = await this.deps.skills.reload()
      const response = skills.length === 0
        ? "✅ Skills reloaded. No skills found in .agent/skills/"
        : `✅ Skills reloaded (${skills.length}):\n\n` +
          skills.map(s => `• *${s.name}* — ${s.description.slice(0, 80)}`).join("\n")
      await send(response)
      return { handled: true }
    }
    const skills = this.deps.skills.getAll()
    await send(
      skills.length === 0
        ? "No skills loaded.\n\nTo add a skill: create `.agent/skills/<name>/SKILL.md` then run `/skills reload`"
        : `📚 *Loaded skills (${skills.length}):*\n\n` +
          skills.map(s => `• *${s.name}* — ${s.description.slice(0, 80)}`).join("\n") +
          (isAdmin ? "\n\nUse `/skills reload` to reload from disk." : ""),
    )
    return { handled: true }
  }

  private async handleCancel(ctx: ICommandContext, taskId: string, send: SendFn): Promise<ICommandResult> {
    const task = this.deps.tasks.get(taskId)
    if (task && task.sessionId !== ctx.sessionId) {
      await send(`❓ Task not found or already completed.`)
      return { handled: true }
    }
    const cancelled = this.deps.tasks.cancel(taskId)
    await send(cancelled ? `🚫 Task ${taskId} cancelled.` : `❓ Task not found or already completed.`)
    return { handled: true }
  }

  private async handleStatus(ctx: ICommandContext, send: SendFn): Promise<ICommandResult> {
    const hasActive = this.deps.tasks.getRunningBySessionId(ctx.sessionId).length > 0
    await send(
      `🟢 *Agent is running*\n\n` +
      `Model: Claude\n` +
      `Voice: ${this.deps.voice.isEnabled(ctx.from) ? "🔊 on" : "🔇 off"}\n` +
      `Tasks: ${hasActive ? "active" : "idle"}\n\n` +
      `Use /clear to reset session or /help for all commands.`,
    )
    return { handled: true }
  }

  private formatTaskList(sessionId: string): string {
    const tasks = this.deps.tasks.getTasksBySessionId(sessionId)
    if (tasks.length === 0) return "No active tasks."
    return tasks
      .map(t => {
        const elapsed = Math.round((Date.now() - t.startedAt) / 1000)
        const icon = { running: "⏳", done: "✅", error: "❌", cancelled: "🚫" }[t.status]
        return `${icon} [${t.id.slice(0, 6)}] ${t.label} — ${elapsed}s`
      })
      .join("\n")
  }

  private async handleStart(ctx: ICommandContext, send: SendFn): Promise<ICommandResult> {
    if (this.deps.access.isAllowed(ctx.from)) {
      await send(`👋 Hi! I'm your AI agent.\n\nSend me any message to get started.\nUse /help to see available commands.`)
      return { handled: true }
    }
    const user = this.deps.access.getUser(ctx.from) ?? this.deps.access.registerPending(ctx.from)
    await send(`👋 Hi! To get access, send this code to the bot owner:\n\n🔑 *${user.accessCode}*`)
    return { handled: true }
  }
}
