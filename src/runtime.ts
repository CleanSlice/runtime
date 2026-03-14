import type { Message } from "./slices/channel"
import type { Tool } from "./slices/tool"
import type { ILlmGateway } from "./slices/llm"
import type { Event } from "./slices/event"
import { ChannelService } from "./slices/channel"
import { ChannelGateway, type ChannelGatewayConfig } from "./slices/channel/data/channel.gateway"
import { SessionManager } from "./slices/session"
import { SessionGateway } from "./slices/session"
import { AgentGateway } from "./slices/agent"
import { buildSystemPrompt } from "./slices/agent"
import { MemoryManager } from "./slices/memory/memory.module"
import { CronScheduler } from "./slices/cron/cron.module"
import { randomUUID } from "crypto"

export interface RuntimeConfig {
  agentDir?: string
  llm: ILlmGateway
  channels: ChannelGatewayConfig[]
  tools?: Tool[]
}

export class AgentRuntime {
  private agentDir: string
  private llm: ILlmGateway
  private tools: Tool[]
  private channel: ChannelService
  private sessions: SessionManager
  private store: SessionGateway
  private memory: MemoryManager
  private cron: CronScheduler

  constructor(config: RuntimeConfig) {
    this.agentDir = config.agentDir ?? ".agent"
    this.llm = config.llm
    this.tools = config.tools ?? []

    this.channel = new ChannelService()
    for (const cfg of config.channels) {
      this.channel.add(new ChannelGateway(cfg))
    }

    this.sessions = new SessionManager()
    this.store = new SessionGateway(this.agentDir)
    this.memory = new MemoryManager(this.agentDir)
    this.cron = new CronScheduler(this.agentDir)
  }

  async start(): Promise<void> {
    await this.memory.load()

    this.channel.onMessage(msg => this.handleMessage(msg))
    await this.channel.start()

    this.cron.onJob(async job => {
      const msg: Message = {
        id: randomUUID(),
        text: job.message,
        from: "cron",
        channel: "internal",
        ts: Date.now(),
        sessionId: `cron:${job.id}`,
      }
      await this.handleMessage(msg)
    })
    this.cron.start()
  }

  async stop(): Promise<void> {
    await this.channel.stop()
    this.cron.stop()
  }

  async handleMessage(msg: Message): Promise<void> {
    const session = this.sessions.getOrCreate(msg.channel, msg.from)
    const sessionId = session.id

    const send = async (text: string) => {
      if (msg.channel !== "internal") {
        await this.channel.send(msg.channel, msg.from, text)
      }
    }

    // 1. Append user event
    const userEvent: Event = {
      id: randomUUID(),
      type: "user",
      ts: Date.now(),
      data: { text: msg.text, from: msg.from },
    }
    await this.store.append(sessionId, userEvent)

    // 2. Load agent context
    const agent = new AgentGateway()
    const agentConfig = await agent.load(this.agentDir)
    const systemPrompt = buildSystemPrompt(agentConfig)

    // 3. Load session history
    const history = await this.store.read(sessionId)

    // 4. Agent loop (tool use)
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
          await this.store.append(sessionId, callEvent)
          history.push(callEvent)

          const tool = this.tools.find(t => t.name === call.name)
          let result: unknown
          if (tool) {
            try {
              result = await tool.execute(call.params, { sessionId, agentDir: this.agentDir, send })
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
          await this.store.append(sessionId, resultEvent)
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
          await this.store.append(sessionId, assistantEvent)
          await send(response.text)
        }
      }
    }

    this.sessions.touch(sessionId)
  }
}
