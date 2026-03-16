import type { Tool } from "./slices/tool"
import type { Event } from "./slices/event"
import type { ChannelGatewayConfig } from "./slices/channel"
import type { LlmGatewayConfig } from "./slices/llm/llm.module"
import { S3SyncService, type S3SyncConfig } from "./slices/sync/s3-sync.service"
import { ChannelModule } from "./slices/channel/channel.module"
import { SessionModule } from "./slices/session/session.module"
import { AgentModule } from "./slices/agent/agent.module"
import { MemoryModule } from "./slices/memory/memory.module"
import { CronModule } from "./slices/cron/cron.module"
import { HeartbeatModule } from "./slices/heartbeat/heartbeat.module"
import { AccessModule } from "./slices/access/access.module"
import { InviteRepository } from "./slices/access/data/repositories/invite/invite.repository"
import { LlmModule } from "./slices/llm/llm.module"
import { SkillModule } from "./slices/skill/skill.module"
import { VoiceModule } from "./slices/voice/voice.module"
import { TaskManager } from "./slices/task/task.manager"
import { Dispatcher } from "./slices/task/dispatcher"
import type { Task } from "./slices/task/task.manager"
import { randomUUID } from "crypto"

export interface RuntimeConfig {
  agentDir?: string
  llm: LlmGatewayConfig
  channels: ChannelGatewayConfig[]
  tools?: Tool[]
  s3?: S3SyncConfig
}

export class AgentRuntime {
  private agentDir: string
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
  private tasks: TaskManager
  private dispatcher: Dispatcher
  private s3sync?: S3SyncService

  constructor(config: RuntimeConfig) {
    this.agentDir = require("path").resolve(config.agentDir ?? ".agent")
    this.tools = config.tools ?? []

    this.llm = new LlmModule(config.llm)
    this.channel = new ChannelModule(config.channels)
    this.session = new SessionModule(this.agentDir)
    this.agent = new AgentModule(this.agentDir)
    this.memory = new MemoryModule(this.agentDir)
    this.cron = new CronModule(this.agentDir)
    this.heartbeat = new HeartbeatModule(this.agentDir, 30 * 60 * 1000)
    const adminIds = (process.env.ADMIN_IDS ?? "").split(",").filter(Boolean)
    this.access = new AccessModule(this.agentDir, adminIds, new InviteRepository())
    this.skills = new SkillModule(this.agentDir)
    this.voice = new VoiceModule(this.agentDir)
    this.tasks = new TaskManager()
    this.dispatcher = new Dispatcher(this.tasks)

    if (config.s3) {
      this.s3sync = new S3SyncService(config.s3, this.agentDir)
    } else if (process.env.S3_BUCKET) {
      this.s3sync = new S3SyncService({ bucket: process.env.S3_BUCKET, prefix: process.env.S3_PREFIX }, this.agentDir)
    }
  }

  async start(): Promise<void> {
    // Pull data from S3 before loading anything
    if (this.s3sync) {
      await this.s3sync.pull()
      this.s3sync.startAutoSync(60)
    }

    await this.memory.load()
    await this.skills.load()

    this.channel.onMessage(msg => this.handleMessage(msg))
    await this.channel.start()

    this.cron.onJob(async job => {
      await this.handleMessage({
        id: randomUUID(),
        text: job.message,
        from: job.to ?? "cron",
        channel: job.channel ?? "internal",
        ts: Date.now(),
        sessionId: `cron:${job.id}`,
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

  async stop(): Promise<void> {
    await this.channel.stop()
    this.cron.stop()
    this.heartbeat.stop()
    if (this.s3sync) {
      this.s3sync.stopAutoSync()
      await this.s3sync.push()  // final push on shutdown
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
      const botUsername = process.env.BOT_USERNAME ?? "dv_cleanslice_bot"

      // /start <invite_code>
      const startMatch = text.match(/^\/start\s+(\S+)/)
      if (startMatch) {
        const result = this.access.processInvite(msg.from, startMatch[1])
        if (result.activated && !result.alreadyActive) {
          const activatedLink = this.access.getInviteLink(result.activated.userId, botUsername)
          await this.channel.send(msg.channel, result.activated.userId,
            `🎉 Ты активирован!\n\nТеперь можешь общаться с ботом.\n\nПоделись своей ссылкой:\n${activatedLink}`
          )
        }
        const newUserLink = this.access.getInviteLink(msg.from, botUsername)
        await this.channel.send(msg.channel, msg.from,
          `👋 Привет!\n\nЧтобы получить доступ — пригласи друга:\n${newUserLink}`
        )
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

      // /start (no code)
      if (text === "/start") {
        if (this.access.isAllowed(msg.from)) {
          await this.channel.send(msg.channel, msg.from, "✅ Всё работает. Просто напиши что нужно.")
          return
        }
        this.access.getUser(msg.from) ?? this.access.registerPending(msg.from)
        const link = this.access.getInviteLink(msg.from, botUsername)
        await this.channel.send(msg.channel, msg.from,
          `👋 Привет!\n\nЧтобы получить доступ — пригласи друга:\n${link}`
        )
        return
      }

      // Access check
      if (!this.access.isAllowed(msg.from)) {
        this.access.getUser(msg.from) ?? this.access.registerPending(msg.from)
        const link = this.access.getInviteLink(msg.from, botUsername)
        await this.channel.send(msg.channel, msg.from,
          `🔒 Доступ закрыт.\n\nПригласи друга:\n${link}`
        )
        return
      }
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
    const taskLabel = msg.text.slice(0, 60) + (msg.text.length > 60 ? "…" : "")
    console.log(`[runtime] starting task for "${taskLabel.slice(0, 40)}"`)

    this.tasks.start(sessionId, taskLabel, async (task: Task) => {
      try {
        const taskId = task.id
        console.log(`[task:${taskId.slice(0, 6)}] started`)

        // Append user message tagged with taskId — each task sees only its own user message
        const userEvent: Event = {
          id: randomUUID(),
          type: "user",
          ts: Date.now(),
          data: { text: msg.text, from: msg.from },
          taskId,  // private to this task
        }
        await this.session.append(sessionId, userEvent)

        // Read shared history + this task's own events
        const history = await this.session.readForTask(sessionId, taskId)

        let systemPrompt = await this.agent.buildPrompt(msg.from)
        const skill = this.skills.select(msg.text)
        if (skill) {
          systemPrompt += `\n\n## Active Skill: ${skill.name}\n${skill.content}`
          console.log(`[skill] activated: ${skill.name}`)
        }

        const MAX_ITERATIONS = 10
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
          } catch (err: unknown) {
            const status = (err as { status?: number })?.status
            console.error(`[task:${taskId.slice(0, 6)}] LLM error (status=${status}):`, err)
            if (!isInternal) await send("⚠️ Что-то пошло не так. Попробуй ещё раз.")
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
                taskId,
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
                taskId,
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
}
