import type { Tool } from "./slices/tool"
import type { Event } from "./slices/event"
import type { ChannelGatewayConfig } from "./slices/channel"
import type { LlmGatewayConfig } from "./slices/llm/llm.module"
import { ChannelModule } from "./slices/channel/channel.module"
import { SessionModule } from "./slices/session/session.module"
import { AgentModule } from "./slices/agent/agent.module"
import { MemoryModule } from "./slices/memory/memory.module"
import { CronModule } from "./slices/cron/cron.module"
import { HeartbeatModule } from "./slices/heartbeat/heartbeat.module"
import { AccessModule } from "./slices/access/access.module"
import { LlmModule } from "./slices/llm/llm.module"
import { randomUUID } from "crypto"

export interface RuntimeConfig {
  agentDir?: string
  llm: LlmGatewayConfig
  channels: ChannelGatewayConfig[]
  tools?: Tool[]
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

  constructor(config: RuntimeConfig) {
    this.agentDir = require("path").resolve(config.agentDir ?? ".agent")
    this.tools = config.tools ?? []

    this.llm = new LlmModule(config.llm)
    this.channel = new ChannelModule(config.channels)
    this.session = new SessionModule(this.agentDir)
    this.agent = new AgentModule(this.agentDir)
    this.memory = new MemoryModule(this.agentDir)
    this.cron = new CronModule(this.agentDir)
    this.heartbeat = new HeartbeatModule(this.agentDir, 30 * 60 * 1000) // every 30 min
    // Admin IDs from env or config — always have access
    const adminIds = (process.env.ADMIN_IDS ?? "").split(",").filter(Boolean)
    this.access = new AccessModule(this.agentDir, adminIds)
  }

  async start(): Promise<void> {
    await this.memory.load()

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

    // Heartbeat — reads .agent/HEARTBEAT.md and acts on it
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
  }

  async handleMessage(msg: { id: string; text: string; from: string; channel: string; ts: number; sessionId: string }): Promise<void> {
    console.log(`[msg] from=${msg.from} channel=${msg.channel} text="${msg.text}"`)
    try {

    // Internal messages (cron, heartbeat) bypass access control
    const isInternal = msg.channel === "internal" || msg.from === "cron" || msg.from === "heartbeat"

    if (!isInternal) {
      const text = msg.text.trim()
      const botUsername = process.env.BOT_USERNAME ?? "dv_cleanslice_bot"

      // Handle /start with invite code: /start <code>
      const startMatch = text.match(/^\/start\s+(\S+)/)
      if (startMatch) {
        const inviteCode = startMatch[1]
        const result = this.access.processInvite(msg.from, inviteCode)

        // Notify the activated user
        if (result.activated && !result.alreadyActive) {
          const activatedLink = this.access.getInviteLink(result.activated.userId, botUsername)
          await this.channel.send(msg.channel, result.activated.userId,
            `🎉 Ты активирован!\n\nТеперь можешь общаться с ботом.\n\nПоделись своей ссылкой чтобы пригласить друга:\n${activatedLink}`
          )
        }

        // New user is now pending
        const newUserLink = this.access.getInviteLink(msg.from, botUsername)
        await this.channel.send(msg.channel, msg.from,
          `👋 Привет!\n\nЧтобы получить доступ — пригласи друга по своей ссылке:\n${newUserLink}\n\nКак только друг примет приглашение, ты получишь доступ автоматически.`
        )
        return
      }

      // Handle plain /start (no code)
      if (text === "/start") {
        const user = this.access.getUser(msg.from)
        if (!user) {
          const record = this.access.registerPending(msg.from)
          const link = this.access.getInviteLink(msg.from, botUsername)
          await this.channel.send(msg.channel, msg.from,
            `👋 Привет!\n\nЧтобы получить доступ — пригласи друга по своей ссылке:\n${link}\n\nКак только друг примет приглашение, ты получишь доступ.`
          )
          return
        }
      }

      // Check access
      if (!this.access.isAllowed(msg.from)) {
        const user = this.access.getUser(msg.from) ?? this.access.registerPending(msg.from)
        const link = this.access.getInviteLink(msg.from, botUsername)
        await this.channel.send(msg.channel, msg.from,
          `🔒 Доступ закрыт.\n\nПригласи друга по своей ссылке чтобы получить доступ:\n${link}`
        )
        return
      }
    }

    const sessionObj = this.session.getOrCreate(msg.channel, msg.from)
    const sessionId = sessionObj.id

    const send = async (text: string) => {
      if (msg.channel !== "internal") {
        await this.channel.send(msg.channel, msg.from, text)
      }
    }

    const userEvent: Event = {
      id: randomUUID(),
      type: "user",
      ts: Date.now(),
      data: { text: msg.text, from: msg.from },
    }
    await this.session.append(sessionId, userEvent)

    const history = await this.session.read(sessionId)

    const systemPrompt = await this.agent.buildPrompt(msg.from)

    let continueLoop = true
    while (continueLoop) {
      const response = await this.llm.complete(systemPrompt, history, this.tools)

      if (response.toolCalls && response.toolCalls.length > 0) {
        for (const call of response.toolCalls) {
          const toolUseId = randomUUID()
          const callEvent: Event = {
            id: randomUUID(),
            type: "tool_call",
            ts: Date.now(),
            data: { name: call.name, params: call.params, toolUseId },
          }
          await this.session.append(sessionId, callEvent)
          history.push(callEvent)

          const tool = this.tools.find(t => t.name === call.name)
          let result: unknown
          if (tool) {
            try {
              result = await tool.execute(call.params, { sessionId, agentDir: this.agentDir, from: msg.from, channel: msg.channel, send })
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
          }
          await this.session.append(sessionId, resultEvent)
          history.push(resultEvent)
        }
      } else {
        continueLoop = false
        if (response.text) {
          const assistantEvent: Event = {
            id: randomUUID(),
            type: "assistant",
            ts: Date.now(),
            data: { text: response.text },
          }
          await this.session.append(sessionId, assistantEvent)
          await send(response.text)
        }
      }
    }

    this.session.touch(sessionId)
    } catch (err) {
      console.error(`[error] handleMessage failed:`, err)
    }
  }
}
