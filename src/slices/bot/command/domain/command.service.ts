import type { ICommandContext, ICommandResult } from "./command.types"
import type { AccessModule } from "../../access/access.module"
import type { StrategyName } from "../../access/domain/access.types"

const VALID_STRATEGIES: StrategyName[] = ["open", "public", "allowlist", "code", "approval"]
import type { SkillModule } from "../../../agent/skill/skill.module"
import type { VoiceModule } from "../../voice/voice.module"
import type { TaskManager } from "../../../agent/task/domain/task.service"
import type { SessionModule } from "../../../agent/session/session.module"
import type { MemoryModule } from "../../../agent/memory/memory.module"
import type { LlmModule } from "../../../setup/llm/llm.module"
import type { GuardModule } from "../../../agent/guard"
import type { IPromptBreakdown } from "../../../agent/agent/agent.module"
import type { InstinctModule } from "../../../agent/instinct"

interface CommandDeps {
  access: AccessModule
  skills: SkillModule
  voice: VoiceModule
  tasks: TaskManager
  session: SessionModule
  memory: MemoryModule
  llm: LlmModule
  /** Guardrails — `/rules` (CLEAN-150 US1). Optional so bare deployments without rules still command. */
  guard?: GuardModule
  /** The latest system-prompt accounting of a session — `/context` (CLEAN-150 US2). */
  context?: (sessionId: string) => IPromptBreakdown | undefined
  /** Learned behaviours — `/learned` family (CLEAN-150 US3). */
  instincts?: InstinctModule
}

// Commands only await the send; the id a channel may hand back is not theirs to use.
type SendFn = (text: string) => Promise<string | void>

export class CommandService {
  constructor(private deps: CommandDeps) {}

  async handle(ctx: ICommandContext, send: SendFn): Promise<ICommandResult> {
    const text = ctx.text.trim()

    // /skills — list or reload skills (admin only)
    if (text === "/skills" || text === "/skills reload") {
      return this.handleSkills(ctx, text, send)
    }

    // /access [strategy] — view or switch access strategy
    if (text === "/access" || text.startsWith("/access ")) {
      return this.handleAccess(ctx, text, send)
    }

    // /rules [reload] — guardrails in force and what fired (admin only)
    if (text === "/rules" || text === "/rules reload") {
      return this.handleRules(ctx, text, send)
    }

    // /context — where the always-on prompt's characters went last turn (admin only)
    if (text === "/context") {
      return this.handleContext(ctx, send)
    }

    // /learned … — what the agent has learned, and steering it (admin only)
    if (text === "/learned" || text.startsWith("/learned ")) {
      return this.handleLearned(ctx, text, send)
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
        `/skills reload — Reload skills from disk (admin only)\n` +
        `/access — Show current access strategy\n` +
        `/access <name> — Switch strategy: open|public|allowlist|code|approval (admin only)\n` +
        `/rules — Guardrails in force and what fired today (admin only)\n` +
        `/rules reload — Re-read .agent/rules/ (admin only)\n` +
        `/context — System prompt size per section vs budget, and what was loaded on demand (admin only)\n` +
        `/learned — What the agent has learned, with confidence (admin only)\n` +
        `/learned show|pin|unpin|prune <id> · promote <id…> · prune · export (admin only)`,
      )
      return { handled: true }
    }

    // /status
    if (text === "/status") {
      return this.handleStatus(ctx, send)
    }

    // /clear — reset session
    if (text === "/clear") {
      // Review the ending session before wiping it, so short conversations
      // that never reached the turn-cadence still get a self-improvement pass.
      // flushReview captures events up front, so clearing right after is safe.
      await this.deps.memory.flushReview(ctx.sessionId, this.deps.llm, this.deps.session)
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

  private async handleRules(ctx: ICommandContext, text: string, send: SendFn): Promise<ICommandResult> {
    if (!this.deps.access.isAdmin(ctx.from)) {
      await send("🔒 Only admins can see the rules.")
      return { handled: true }
    }
    const guard = this.deps.guard
    if (!guard) {
      await send("Guardrails are not enabled on this runtime.")
      return { handled: true }
    }
    if (text === "/rules reload") {
      try {
        await guard.load()
      } catch (err) {
        // The previous set stays in force; say exactly which file is wrong.
        await send(`❌ Rules not reloaded — the previous set stays active.\n\n${(err as Error).message}`)
        return { handled: true }
      }
    }
    const rules = guard.listRules()
    const fired = new Map(guard.recentFirings(24).map(f => [f.id, f.times]))
    const failures = guard.observerFailures()
    const lines = rules
      .sort((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id))
      .map(r => {
        const flags = [r.source, r.event, r.action, r.enabled ? null : "disabled", r.protected ? "protected" : null].filter(Boolean).join(" · ")
        const times = fired.get(r.id)
        const failed = failures[r.id]
        return `• *${r.id}* — ${flags}${times ? ` · fired ${times}× today` : ""}${failed ? ` · observer failed ${failed}×` : ""}`
      })
    const head = guard.isLoaded
      ? `🛡 *Rules in force (${rules.length})*`
      : `⛔ *Rules failed to load — every tool call is blocked*\n${guard.lastLoadError ?? ""}`
    await send(
      `${head}\n\n${lines.join("\n") || "(none)"}` +
      `\n\nAgent rules live in \`.agent/rules/*.md\`; protected rules come with the platform. ` +
      (text === "/rules reload" ? "Reloaded from disk." : "Use `/rules reload` after editing."),
    )
    return { handled: true }
  }

  private async handleContext(ctx: ICommandContext, send: SendFn): Promise<ICommandResult> {
    if (!this.deps.access.isAdmin(ctx.from)) {
      await send("🔒 Only admins can see the context breakdown.")
      return { handled: true }
    }
    const b = this.deps.context?.(ctx.sessionId)
    if (!b) {
      await send("No turn has run in this session yet — send a message first, then `/context`.")
      return { handled: true }
    }
    const pct = (n: number, d: number) => d > 0 ? ` (${Math.round((n / d) * 100)}%)` : ""
    const lines = b.sections.map(s =>
      `• ${s.name}: ${s.chars.toLocaleString()}${s.budget !== undefined ? ` / ${s.budget.toLocaleString()}${pct(s.chars, s.budget)}` : ""}${s.over ? " ⚠ over" : ""}`,
    )
    const onDemand = b.onDemand.length > 0
      ? b.onDemand.map(l => `• ${l.kind} ${l.name}: ${l.chars.toLocaleString()}`).join("\n")
      : "(nothing loaded on demand this turn)"
    await send(
      `📐 *Context — last turn*\n\n` +
      `Always-on prompt: ${b.total.toLocaleString()} / ${b.budget.toLocaleString()} chars${pct(b.total, b.budget)}${b.total > b.budget ? " ⚠ over budget" : ""}\n\n` +
      `${lines.join("\n")}\n\n*On demand:*\n${onDemand}`,
    )
    return { handled: true }
  }

  private async handleLearned(ctx: ICommandContext, text: string, send: SendFn): Promise<ICommandResult> {
    if (!this.deps.access.isAdmin(ctx.from)) {
      await send("🔒 Only admins can see what the agent has learned.")
      return { handled: true }
    }
    const instincts = this.deps.instincts
    if (!instincts) {
      await send("Learning is not enabled on this runtime.")
      return { handled: true }
    }
    const [, sub = "", ...args] = text.split(/\s+/)
    const fmt = (i: ReturnType<InstinctModule["list"]>[number]) =>
      `• \`${i.id}\` ${i.confidence.toFixed(2)} ${instincts.bandOf(i.confidence)}${i.pinned ? " 📌" : ""}${i.promotedTo ? ` → ${i.promotedTo}` : ""}\n` +
      `   when ${i.trigger} → ${i.action.slice(0, 120)}\n` +
      `   evidence ${i.evidence.length} · ${i.source} · reinforced ${new Date(i.reinforced).toISOString().slice(0, 10)}`

    try {
      switch (sub) {
        case "": {
          const all = instincts.list()
          if (all.length === 0) {
            await send("Nothing learned yet. Corrections, resolved errors and repeated workflows become behaviours after the next review pass.")
            return { handled: true }
          }
          const byBand = (b: string) => all.filter(i => instincts.bandOf(i.confidence) === b && !i.conflictsWith)
          const sections = (["core", "apply", "suggested", "hidden"] as const)
            .map(b => [b, byBand(b)] as const)
            .filter(([, list]) => list.length > 0)
            .map(([b, list]) => `*${b}* (${list.length})\n${list.map(fmt).join("\n")}`)
          const conflicts = instincts.conflicts()
          if (conflicts.length > 0) {
            sections.push(`*conflicts* (${conflicts.length})\n` + conflicts.map(c => `• \`${c.loser.id}\` yields to \`${c.winner.id}\` — resolve with /learned prune <id> or pin`).join("\n"))
          }
          await send(`🧠 *Learned behaviours (${all.length})*\n\n${sections.join("\n\n")}\n\n/learned show|pin|unpin|prune <id> · promote <id…> · prune · export`)
          return { handled: true }
        }
        case "show": {
          const i = args[0] ? instincts.get(args[0]) : undefined
          if (!i) { await send(`No behaviour with id \`${args[0] ?? ""}\`.`); return { handled: true } }
          const evidence = i.evidence.map(e => `  - ${e.ref}${e.note ? ` — ${e.note}` : ""}`).join("\n") || "  (none)"
          await send(`${fmt(i)}\n\n*Action*\n${i.action}\n\n*Evidence*\n${evidence}${i.conflictsWith ? `\n\n⚠ yields to \`${i.conflictsWith}\`` : ""}`)
          return { handled: true }
        }
        case "pin":
        case "unpin": {
          if (!args[0] || !instincts.get(args[0])) { await send(`No behaviour with id \`${args[0] ?? ""}\`.`); return { handled: true } }
          if (sub === "pin") instincts.pin(args[0]); else instincts.unpin(args[0])
          await send(`${sub === "pin" ? "📌 Pinned" : "Unpinned"} \`${args[0]}\`.`)
          return { handled: true }
        }
        case "prune": {
          const removed = instincts.prune(args[0])
          await send(removed.length === 0
            ? (args[0] ? `No behaviour with id \`${args[0]}\`.` : "Nothing to prune — no unpinned behaviour has sat below the suggested band long enough.")
            : `🗑 Removed ${removed.length}: ${removed.map(id => `\`${id}\``).join(", ")}`)
          return { handled: true }
        }
        case "promote": {
          if (args.length === 0) { await send("Usage: /learned promote <id> [<id> …]"); return { handled: true } }
          const slug = args.map(id => id.split("-")[0]).join("-").slice(0, 40).replace(/[^a-z0-9-]/g, "") || "behaviours"
          const result = instincts.promote(args, slug)
          await this.deps.skills.reload()
          await send(`✅ Wrote skill \`${result.name}\` at ${result.path} for review — edit it like any skill. The behaviours stay in memory, marked as promoted.`)
          return { handled: true }
        }
        case "export": {
          const all = instincts.list()
          const md = all.map(i => `## ${i.id}\n\n- trigger: ${i.trigger}\n- confidence: ${i.confidence} (${instincts.bandOf(i.confidence)})\n- source: ${i.source}${i.pinned ? ", pinned" : ""}\n\n${i.action}\n`).join("\n")
          await send(md || "Nothing to export.")
          return { handled: true }
        }
        default:
          await send("Usage: /learned · /learned show|pin|unpin|prune <id> · /learned promote <id…> · /learned prune · /learned export")
          return { handled: true }
      }
    } catch (err) {
      await send(`❌ ${(err as Error).message}`)
      return { handled: true }
    }
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

  private async handleAccess(ctx: ICommandContext, text: string, send: SendFn): Promise<ICommandResult> {
    const current = this.deps.access.getStrategyName()
    const arg = text.replace(/^\/access\s*/, "").trim()

    if (!arg) {
      await send(`🔐 Current access strategy: *${current}*\n\nAvailable: ${VALID_STRATEGIES.join(", ")}\nSwitch via /access <name> (admin only).`)
      return { handled: true }
    }

    if (!this.deps.access.isAdmin(ctx.from)) {
      await send("🔒 Only admins can change the access strategy.")
      return { handled: true }
    }

    const next = arg.toLowerCase() as StrategyName
    if (!VALID_STRATEGIES.includes(next)) {
      await send(`❓ Unknown strategy "${arg}". Use one of: ${VALID_STRATEGIES.join(", ")}.`)
      return { handled: true }
    }

    if (next === "allowlist" || next === "code") {
      await send(`⚠️ "${next}" requires extra config (allowlist users / accessCode). Use the \`set_access_strategy\` tool with parameters instead.`)
      return { handled: true }
    }

    this.deps.access.setStrategy(next)
    await send(`✅ Access strategy switched to *${next}*.`)
    return { handled: true }
  }

  private async handleStart(ctx: ICommandContext, send: SendFn): Promise<ICommandResult> {
    if (this.deps.access.isAllowed(ctx.from)) {
      await send(`👋 Привіт! Я твій AI-агент.\n\nНадішли будь-яке повідомлення, щоб почати.\nВикористовуй /help, щоб побачити доступні команди.`)
      return { handled: true }
    }
    const user = this.deps.access.getUser(ctx.from) ?? this.deps.access.registerPending(ctx.from)
    if (!user.accessCode) {
      await send(`👋 Привіт! Тебе ще немає у списку доступу. Звернися до власника бота, щоб отримати доступ.`)
    } else {
      await send(`👋 Привіт! Щоб отримати доступ, надішли цей код власнику бота:\n\n🔑 *${user.accessCode}*`)
    }
    return { handled: true }
  }
}
