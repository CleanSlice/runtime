import type { Tool } from "./slices/agent/tool"
import { ToolService } from "./slices/agent/tool/domain/tool.service"
import type { Event } from "./slices/agent/event"
import type { ChannelGatewayConfig } from "./slices/setup/channel"
import type { LlmGatewayConfig } from "./slices/setup/llm/llm.module"
import { S3SyncService, type S3SyncConfig } from "./slices/agent/sync/s3-sync.service"
import { ChannelModule } from "./slices/setup/channel/channel.module"
import { SessionModule } from "./slices/agent/session/session.module"
import { AgentModule } from "./slices/agent/core/agent.module"
import { MemoryModule } from "./slices/agent/memory/memory.module"
import { CronModule } from "./slices/agent/cron/cron.module"
import { HeartbeatModule } from "./slices/agent/heartbeat/heartbeat.module"
import { AccessModule } from "./slices/bot/access/access.module"
import { ApprovalRepository } from "./slices/bot/access/data/repositories/approval/approval.repository"
import { OpenRepository } from "./slices/bot/access/data/repositories/open/open.repository"
import { AllowlistRepository } from "./slices/bot/access/data/repositories/allowlist/allowlist.repository"
import { CodeRepository } from "./slices/bot/access/data/repositories/code/code.repository"
import type { IAccessStrategy } from "./slices/bot/access/domain/access.types"
import { LlmModule } from "./slices/setup/llm/llm.module"
import { SkillModule } from "./slices/agent/skill/skill.module"
import { VoiceModule } from "./slices/agent/voice/voice.module"
import { UsageModule } from "./slices/agent/usage/usage.module"
import { TaskManager } from "./slices/agent/task/task.manager"
import { Dispatcher } from "./slices/agent/task/dispatcher"
import type { Task } from "./slices/agent/task/task.manager"
import { randomUUID } from "crypto"
import { readFileSync, writeFileSync } from "fs"
import { InitModule, type IAgentConfig } from "./slices/agent/init"
import { SecretModule } from "./slices/setup/secret/secret.module"

export interface RuntimeConfig {
  init: InitModule
  llm: LlmGatewayConfig
  channels: ChannelGatewayConfig[]
  tools?: Tool[]
  s3?: S3SyncConfig
}

export class AgentRuntime {
  private agentDir: string
  private config: IAgentConfig
  private llm: LlmModule
  private tools: Tool[]
  private channel: ChannelModule
  private session: SessionModule
  private agent: AgentModule
  private memory: MemoryModule
  private cron: CronModule
  private heartbeat: HeartbeatModule
  private access: AccessModule
  private skills: SkillModule
  private voice: VoiceModule
  private usage: UsageModule
  private tasks: TaskManager
  private dispatcher: Dispatcher
  private toolingPrompt: string
  private stopPhrases: Set<string>
  private secrets: SecretModule
  private s3sync?: S3SyncService

  constructor(config: RuntimeConfig) {
    this.agentDir = config.init.agentDir
    this.config = config.init.config
    this.tools = config.tools ?? []
    this.toolingPrompt = ToolService.buildToolingPromptFrom(this.tools)
    this.stopPhrases = new Set(this.config.stopPhrases.map(p => p.toLowerCase()))
    this.secrets = new SecretModule(this.agentDir)

    this.llm = new LlmModule(config.llm)
    this.channel = new ChannelModule(config.channels)
    this.session = new SessionModule(this.agentDir, {
      compactionThreshold: this.config.session.compactionThreshold,
      recentKeep: this.config.session.recentKeep,
    })
    this.agent = new AgentModule(this.agentDir)
    this.memory = new MemoryModule(this.agentDir)
    this.cron = new CronModule(this.agentDir)
    this.heartbeat = new HeartbeatModule(this.agentDir, this.config.heartbeat.intervalMin * 60 * 1000)
    const adminIds = (process.env.TELEGRAM_BOT_ADMIN_IDS ?? "").split(",").filter(Boolean)
    this.access = new AccessModule(this.agentDir, adminIds, this.buildAccessStrategy())
    this.skills = new SkillModule(this.agentDir)
    this.voice = new VoiceModule(this.agentDir)
    this.usage = new UsageModule(this.agentDir)
    this.tasks = new TaskManager()
    this.dispatcher = new Dispatcher(this.tasks)

    if (config.s3) {
      this.s3sync = new S3SyncService(config.s3, this.agentDir)
    } else if (process.env.S3_BUCKET) {
      this.s3sync = new S3SyncService({ bucket: process.env.S3_BUCKET, prefix: process.env.S3_PREFIX }, this.agentDir)
    }
  }

  private buildAccessStrategy(): IAccessStrategy {
    const strategy = this.config.accessStrategy ?? "approval"
    switch (strategy) {
      case "open":
        return new OpenRepository()
      case "allowlist":
        return new AllowlistRepository(this.config.allowlist ?? [])
      case "code":
        return new CodeRepository(this.config.accessCode ?? "")
      case "approval":
      default:
        return new ApprovalRepository()
    }
  }

  async start(): Promise<void> {
    // Pull data from S3 before loading anything
    if (this.s3sync) {
      await this.s3sync.pull()
      this.s3sync.startAutoSync(this.config.s3?.syncIntervalSec ?? 60)
    }

    // Write admin IDs to MEMORY.md so the agent knows who the owner is
    this.ensureAdminInMemory()

    await this.memory.load()
    await this.skills.load()
    this.usage.start()

    this.channel.onMessage(msg => this.handleMessage(msg))
    await this.channel.start()

    this.cron.onJob(async job => {
      const from = job.to ?? "cron"
      const channel = job.channel ?? "internal"
      await this.handleMessage({
        id: randomUUID(),
        text: job.message,
        from,
        channel,
        ts: Date.now(),
        // Run in user's session so the agent sees conversation history
        sessionId: `${channel}:${from}`,
      })
    })
    this.cron.start()

    this.heartbeat.onHeartbeat(async (message) => {
      await this.handleMessage({
        id: randomUUID(),
        text: message,
        from: "heartbeat",
        channel: "internal",
        ts: Date.now(),
        sessionId: "heartbeat",
      })
    })
    this.heartbeat.start()
  }

  private ensureAdminInMemory(): void {
    const memoryPath = `${this.agentDir}/MEMORY.md`
    const adminIds = (process.env.TELEGRAM_BOT_ADMIN_IDS ?? "").split(",").filter(Boolean)
    if (adminIds.length === 0) return

    const marker = "## Bot Owner"
    const ownerBlock = `${marker}\n
Admin IDs: ${adminIds.join(", ")}

### Access Control — How User Approval Works
- New users who message the bot receive a 6-character access code (e.g. A3F2B1).
- They must send this code to the bot owner (you, the admin) — via any messenger, in person, etc.
- The admin then sends the code to this bot to approve the user.

### How to Recognize an Approval Request
When the admin sends you a message, look for a 6-character alphanumeric code. It may come in many forms:
- Just the code: "A3F2B1"
- With a command: "/approve A3F2B1"
- Copy-pasted instructions: "Owner types /approve A3F2B1 in the bot → user gets approved"
- With context: "вот код от пользователя: A3F2B1"
- As part of a forwarded message or screenshot text

In ALL these cases — extract the code and call the \`approve_user\` tool. Do NOT treat the surrounding text literally. The admin is not asking you to explain what "/approve" does — they are giving you a code to approve.

RULE: If the message from an admin contains anything that looks like a 6-char uppercase alphanumeric code, call \`approve_user\` with it first. If it fails (no pending user), then treat the message normally.
`

    try {
      const content = readFileSync(memoryPath, "utf-8")
      if (content.includes(marker)) {
        // Update existing block
        const updated = content.replace(
          new RegExp(`${marker}[\\s\\S]*?(?=\\n## |$)`),
          ownerBlock,
        )
        writeFileSync(memoryPath, updated)
      } else {
        writeFileSync(memoryPath, content + "\n" + ownerBlock)
      }
    } catch {
      writeFileSync(memoryPath, ownerBlock)
    }
    console.log(`[init] admin IDs written to MEMORY.md: ${adminIds.join(", ")}`)
  }

  async stop(): Promise<void> {
    await this.channel.stop()
    this.cron.stop()
    this.heartbeat.stop()
    await this.usage.flush()   // final usage report before shutdown
    if (this.s3sync) {
      this.s3sync.stopAutoSync()
      await this.s3sync.push()  // final push on shutdown (includes usage.json)
    }
  }

  async handleMessage(msg: { id: string; text: string; from: string; channel: string; ts: number; sessionId: string }): Promise<void> {
    console.log(`[msg] from=${msg.from} channel=${msg.channel} text="${msg.text}"`)

    const isInternal = msg.channel === "internal" || msg.from === "cron" || msg.from === "heartbeat"

    // Session scoped by channel+user so that Telegram and Slack tasks for the
    // same user never bleed into each other's dispatch queue.
    const sessionObj = this.session.getOrCreate(msg.channel, msg.from)
    const sessionId = sessionObj.id

    // --- Access control & built-in commands (sync, instant) ---
    if (!isInternal) {
      const text = msg.text.trim()

      // Auto-approve: if admin sends a message containing a 6-char access code
      if (this.access.isAdmin(msg.from)) {
        const codeMatch = text.match(/\b([A-Z0-9]{6})\b/)
        if (codeMatch) {
          const user = this.access.approve(codeMatch[1])
          if (user) {
            console.log(`[access] admin approved user ${user.userId} with code ${codeMatch[1]}`)
            await this.channel.send(msg.channel, user.userId, `🎉 Доступ открыт! Напиши мне что-нибудь.`)
            await this.channel.send(msg.channel, msg.from, `✅ Пользователь ${user.userId} одобрен.`)
            return
          }
        }
      }

      // /skills — list or reload skills (admin only)
      if (text === "/skills" || text === "/skills reload") {
        const isAdmin = this.access.isAdmin(msg.from)
        if (text === "/skills reload") {
          if (!isAdmin) {
            await this.channel.send(msg.channel, msg.from, "🔒 Only admins can reload skills.")
            return
          }
          const skills = await this.skills.reload()
          await this.channel.send(msg.channel, msg.from,
            skills.length === 0
              ? "✅ Skills reloaded. No skills found in .agent/skills/"
              : `✅ Skills reloaded (${skills.length}):\n\n` +
                skills.map(s => `• *${s.name}* — ${s.description.slice(0, 80)}`).join("\n")
          )
        } else {
          const skills = this.skills.getAll()
          await this.channel.send(msg.channel, msg.from,
            skills.length === 0
              ? "No skills loaded.\n\nTo add a skill: create `.agent/skills/<name>/SKILL.md` then run `/skills reload`"
              : `📚 *Loaded skills (${skills.length}):*\n\n` +
                skills.map(s => `• *${s.name}* — ${s.description.slice(0, 80)}`).join("\n") +
                (isAdmin ? "\n\nUse `/skills reload` to reload from disk." : "")
          )
        }
        return
      }

      // /voice toggle
      if (text === "/voice") {
        const isNowOn = this.voice.toggle(msg.from)
        await this.channel.send(msg.channel, msg.from,
          isNowOn ? "🔊 Voice mode enabled" : "🔇 Voice mode disabled"
        )
        return
      }

      // /tasks — list active tasks
      if (text === "/tasks") {
        await this.channel.send(msg.channel, msg.from, this.tasks.formatList(sessionId))
        return
      }

      // /cancel <id>
      const cancelMatch = text.match(/^\/cancel\s+(\S+)/)
      if (cancelMatch) {
        const taskId = cancelMatch[1]
        const task = this.tasks.get(taskId)
        // Reject if task exists but belongs to a different session (channel+user)
        if (task && task.sessionId !== sessionId) {
          await this.channel.send(msg.channel, msg.from, `❓ Задача не найдена или уже завершена.`)
          return
        }
        const cancelled = this.tasks.cancel(taskId)
        await this.channel.send(msg.channel, msg.from,
          cancelled ? `🚫 Задача ${taskId} отменена.` : `❓ Задача не найдена или уже завершена.`
        )
        return
      }

      // /help
      if (text === "/help") {
        await this.channel.send(msg.channel, msg.from,
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
          `/skills reload — Reload skills from disk (admin only)`
        )
        return
      }

      // /status
      if (text === "/status") {
        const activeTasks = this.tasks.formatList(sessionId)
        const hasActive = !activeTasks.includes("нет активных") && !activeTasks.includes("No active")
        await this.channel.send(msg.channel, msg.from,
          `🟢 *Agent is running*\n\n` +
          `Model: Claude\n` +
          `Voice: ${this.voice.isEnabled(msg.from) ? "🔊 on" : "🔇 off"}\n` +
          `Tasks: ${hasActive ? "active" : "idle"}\n\n` +
          `Use /clear to reset session or /help for all commands.`
        )
        return
      }

      // /clear — reset session
      if (text === "/clear") {
        this.session.clear(msg.channel, msg.from)
        await this.channel.send(msg.channel, msg.from,
          `✅ Session cleared. Starting fresh!`
        )
        return
      }

      // /memory — ask LLM to summarize what it knows about the user
      if (text === "/memory") {
        // Fall through to LLM with injected text
        return await this.handleMessage({
          ...msg,
          text: "Please summarize what you know and remember about me from memory. Be concise.",
        })
      }

      // /start
      if (text === "/start") {
        if (this.access.isAllowed(msg.from)) {
          await this.channel.send(msg.channel, msg.from,
            `👋 Hi! I'm your AI agent.\n\nSend me any message to get started.\nUse /help to see available commands.`
          )
        } else {
          const user = this.access.getUser(msg.from) ?? this.access.registerPending(msg.from)
          await this.channel.send(msg.channel, msg.from,
            `👋 Hi! To get access, send this code to the bot owner:\n\n🔑 *${user.accessCode}*`
          )
        }
        return
      }

      // Access check
      if (!this.access.isAllowed(msg.from)) {
        const user = this.access.getUser(msg.from) ?? this.access.registerPending(msg.from)
        await this.channel.send(msg.channel, msg.from,
          `🔒 Access denied.\n\nSend this code to the bot owner to get access:\n\n🔑 *${user.accessCode}*`
        )
        return
      }
    }

    // --- Stop detection: cancel all running tasks ---
    if (!isInternal && this.isStopCommand(msg.text)) {
      const cancelled = this.tasks.cancelAll(sessionId)
      if (cancelled > 0) {
        await this.channel.send(msg.channel, msg.from, `Stopped ${cancelled} task${cancelled > 1 ? "s" : ""}.`)
      }
      return
    }

    // --- Dispatcher: decide what to do with this message ---
    const send = async (text: string) => {
      if (msg.channel !== "internal") {
        await this.channel.send(msg.channel, msg.from, text)
      }
    }

    if (!isInternal) {
      const decision = this.dispatcher.dispatch(sessionId, msg.text)

      if (decision.kind === "ask") {
        // Ambiguous — ask user and wait for their clarification
        await send(decision.question)
        // Store pending message to attach after user replies
        // (for now just start a new task — user can /cancel if needed)
      }

      if (decision.kind === "join") {
        // Inject into existing task's inbox
        console.log(`[dispatcher] joining task ${decision.task.id.slice(0, 6)}: "${msg.text.slice(0, 40)}"`)
        this.tasks.inject(decision.task.id, msg.text)

        // Append to session as shared context (no taskId — visible to all)
        const userEvent: Event = {
          id: randomUUID(),
          type: "user",
          ts: Date.now(),
          data: { text: msg.text, from: msg.from },
          // no taskId — shared context
        }
        await this.session.append(sessionId, userEvent)
        return
      }
    }

    // --- Start new task (fire-and-forget) ---
    const labelLen = this.config.taskLabelLength
    const taskLabel = msg.text.slice(0, labelLen) + (msg.text.length > labelLen ? "…" : "")
    console.log(`[runtime] starting task for "${taskLabel.slice(0, 40)}"`)

    this.tasks.start(sessionId, taskLabel, async (task: Task) => {
      try {
        const taskId = task.id
        console.log(`[task:${taskId.slice(0, 6)}] started`)

        // Append user message as shared context so future tasks can see it
        const userEvent: Event = {
          id: randomUUID(),
          type: "user",
          ts: Date.now(),
          data: { text: msg.text, from: msg.from },
          // no taskId — shared, so future tasks see what was requested
        }
        await this.session.append(sessionId, userEvent)

        // Read shared history + this task's own events
        const history = await this.session.readForTask(sessionId, taskId)

        const secretKeys = await this.secrets.list(msg.from).catch(() => [] as string[])
        let systemPrompt = await this.agent.buildPrompt({ userId: msg.from, toolingPrompt: this.toolingPrompt, secretKeys })
        const skill = this.skills.select(msg.text)
        if (skill) {
          systemPrompt += `\n\n## Active Skill: ${skill.name}\n${skill.content}`
          console.log(`[skill] activated: ${skill.name}`)
        }

        const MAX_ITERATIONS = this.config.maxIterations
        let continueLoop = true
        let iterations = 0

        while (continueLoop) {
          if (task.controller.signal.aborted) {
            console.log(`[task:${taskId.slice(0, 6)}] cancelled`)
            break
          }

          // Check inbox — if user sent clarification, append it to history and session
          while (task.inbox.length > 0) {
            const inboxText = task.inbox.shift()!
            console.log(`[task:${taskId.slice(0, 6)}] inbox: "${inboxText.slice(0, 40)}"`)
            const inboxEvent: Event = {
              id: randomUUID(),
              type: "user",
              ts: Date.now(),
              data: { text: inboxText, from: msg.from },
              taskId,
            }
            await this.session.append(sessionId, inboxEvent)
            history.push(inboxEvent)
          }

          if (++iterations > MAX_ITERATIONS) {
            console.error(`[task:${taskId.slice(0, 6)}] exceeded ${MAX_ITERATIONS} iterations`)
            await send("⚠️ Reached max iterations. Please try again.")
            break
          }

          let response
          try {
            console.log(`[task:${taskId.slice(0, 6)}] calling llm iter=${iterations}`)
            const canStream = msg.channel === "telegram" && !isInternal && this.llm.canStream()
            if (canStream) {
              // Stream response — send placeholder and edit as tokens arrive
              console.log(`[task:${taskId.slice(0, 6)}] streaming response...`)
              let streamedResponse: import("./slices/llm/domain/llm.types").ModelResponse | undefined
              await this.channel.streamSend(msg.channel, msg.from, async (onChunk) => {
                streamedResponse = await this.llm.stream(systemPrompt, history, this.tools, onChunk)
                return streamedResponse.text ?? ""
              })
              console.log(`[task:${taskId.slice(0, 6)}] stream complete, text=${streamedResponse?.text?.length ?? 0}`)
              response = streamedResponse!
            } else {
              response = await this.llm.complete(systemPrompt, history, this.tools)
            }
            console.log(`[task:${taskId.slice(0, 6)}] llm ok, text=${response.text?.length ?? 0} tools=${response.toolCalls?.length ?? 0}`)
            this.usage.add(response.usage)
          } catch (err: unknown) {
            const status = (err as { status?: number })?.status
            const errMsg = String((err as { message?: unknown })?.message ?? err ?? "")
            const isOverloaded = errMsg.includes("overloaded_error") || errMsg.includes("Overloaded") || status === 529
            console.error(`[task:${taskId.slice(0, 6)}] LLM error (status=${status}):`, err)
            if (!isInternal) {
              if (isOverloaded) {
                await send("⚠️ Сервер AI перегружен. Подожди минуту и попробуй снова.")
              } else {
                await send("⚠️ Что-то пошло не так. Попробуй ещё раз.")
              }
            }
            break
          }

          if (response.toolCalls && response.toolCalls.length > 0) {
            for (const call of response.toolCalls) {
              if (task.controller.signal.aborted) break
              console.log(`[task:${taskId.slice(0, 6)}] tool_call: ${call.name}`)

              const toolUseId = randomUUID()
              const callEvent: Event = {
                id: randomUUID(),
                type: "tool_call",
                ts: Date.now(),
                data: { name: call.name, params: call.params, toolUseId },
                // no taskId — shared, so future tasks see what tools were called
              }
              await this.session.append(sessionId, callEvent)
              history.push(callEvent)

              const tool = this.tools.find(t => t.name === call.name)
              console.log(`[task:${taskId.slice(0, 6)}] tool found: ${!!tool}`)
              let result: unknown
              if (tool) {
                try {
                  result = await tool.execute(call.params, {
                    sessionId,
                    agentDir: this.agentDir,
                    from: msg.from,
                    channel: msg.channel,
                    send,
                    agentConfig: this.config,
                    reloadSkills: () => this.skills.reload().then(() => undefined),
                  })
                } catch (err) {
                  result = { error: String(err) }
                }
              } else {
                result = { error: `Unknown tool: ${call.name}` }
              }

              const resultEvent: Event = {
                id: randomUUID(),
                type: "tool_result",
                ts: Date.now(),
                data: { toolUseId, result },
                // no taskId — shared, so future tasks see tool results
              }
              await this.session.append(sessionId, resultEvent)
              history.push(resultEvent)
            }
          } else {
            continueLoop = false
            console.log(`[task:${taskId.slice(0, 6)}] final response, text=${response.text?.length ?? 0}, isInternal=${isInternal}`)
            if (response.text) {
              const assistantEvent: Event = {
                id: randomUUID(),
                type: "assistant",
                ts: Date.now(),
                data: { text: response.text },
                // no taskId — assistant responses are shared context for future tasks
              }
              await this.session.append(sessionId, assistantEvent)

              // If we streamed — message already sent via streamSend, skip re-send
              const wasStreamed = msg.channel === "telegram" && !isInternal && this.llm.canStream()

              if (!wasStreamed) {
                if (msg.channel === "telegram" && this.voice.isEnabled(msg.from)) {
                  const tts = this.tools.find(t => t.name === "tts")
                  if (tts) {
                    try {
                      await tts.execute(
                        { text: response.text, chat_id: msg.from },
                        { sessionId, agentDir: this.agentDir, from: msg.from, channel: msg.channel, send }
                      )
                    } catch (err) {
                      console.error("[voice] TTS failed:", err)
                      await send(response.text)
                    }
                  } else {
                    await send(response.text)
                  }
                } else {
                  console.log(`[task:${taskId.slice(0, 6)}] sending text response`)
                  await send(response.text)
                  console.log(`[task:${taskId.slice(0, 6)}] send done`)
                }
              }
            }
          }
        }

        this.session.touch(sessionId)

        // Fire-and-forget compaction — runs after response, does not block
        this.session.compactAsync(sessionId, this.llm.getGateway())

      } catch (err) {
        console.error(`[task:${task.id.slice(0, 6)}] unhandled:`, err)
        try {
          if (!isInternal) await this.channel.send(msg.channel, msg.from, "⚠️ Что-то пошло не так. Попробуй ещё раз.")
        } catch { /* ignore */ }
      }
    })
  }


  private isStopCommand(text: string): boolean {
    const normalized = text.trim().toLowerCase().replace(/[.!?,;:]+$/, "")
    return this.stopPhrases.has(normalized)
  }
}
