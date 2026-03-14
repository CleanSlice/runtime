import type { ChannelGateway, Message } from "./slices/channel/channel.module"
import type { Tool } from "./slices/tool/tool.module"
import type { ModelLlm } from "./slices/llm/llm.module"
import type { Event } from "./slices/event/event.module"
import { ChannelServer } from "./slices/channel/channel.module"
import { SessionManager } from "./slices/session/session.module"
import { SessionStore } from "./slices/session/data/session.store"
import { loadAgentConfig } from "./slices/agent/data/agent.loader"
import { buildSystemPrompt } from "./slices/agent"
import { MemoryManager } from "./slices/memory/index"
import { CronScheduler } from "./slices/cron/cron.module"
import { randomUUID } from "crypto"

export interface RuntimeConfig {
  agentDir?: string
  model: ModelLlm
  channels: ChannelGateway[]
  tools?: Tool[]
}

export class AgentRuntime {
  private agentDir: string
  private model: ModelLlm
  private tools: Tool[]
  private channelServer: ChannelServer
  private sessionManager: SessionManager
  private sessionStore: SessionStore
  private memoryManager: MemoryManager
  private cronScheduler: CronScheduler

  constructor(config: RuntimeConfig) {
    this.agentDir = config.agentDir ?? ".agent"
    this.model = config.model
    this.tools = config.tools ?? []

    this.channelServer = new ChannelServer()
    for (const ch of config.channels) {
      this.channelServer.add(ch)
    }

    this.sessionManager = new SessionManager()
    this.sessionStore = new SessionStore(this.agentDir)
    this.memoryManager = new MemoryManager(this.agentDir)
    this.cronScheduler = new CronScheduler(this.agentDir)
  }

  async start(): Promise<void> {
    await this.memoryManager.load()

    this.channelServer.onMessage(msg => this.handleMessage(msg))
    await this.channelServer.start()

    this.cronScheduler.onJob(async job => {
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
    this.cronScheduler.start()
  }

  async stop(): Promise<void> {
    await this.channelServer.stop()
    this.cronScheduler.stop()
  }

  async handleMessage(msg: Message): Promise<void> {
    const session = this.sessionManager.getOrCreate(msg.channel, msg.from)
    const sessionId = session.id

    const send = async (text: string) => {
      if (msg.channel !== "internal") {
        await this.channelServer.send(msg.channel, msg.from, text)
      }
    }

    // 1. Append user event
    const userEvent: Event = {
      id: randomUUID(),
      type: "user",
      ts: Date.now(),
      data: { text: msg.text, from: msg.from },
    }
    await this.sessionStore.append(sessionId, userEvent)

    // 2. Load agent context
    const agentConfig = await loadAgentConfig(this.agentDir)
    const systemPrompt = buildSystemPrompt(agentConfig)

    // 3. Load session history
    let history = await this.sessionStore.read(sessionId)

    // 4. Agent loop (tool use)
    let continueLoop = true
    while (continueLoop) {
      const response = await this.model.complete(systemPrompt, history, this.tools)

      if (response.toolCalls && response.toolCalls.length > 0) {
        // Append tool_call events and execute tools
        for (const call of response.toolCalls) {
          const toolUseId = randomUUID()
          const callEvent: Event = {
            id: randomUUID(),
            type: "tool_call",
            ts: Date.now(),
            data: { name: call.name, params: call.params, toolUseId },
          }
          await this.sessionStore.append(sessionId, callEvent)
          history.push(callEvent)

          const tool = this.tools.find(t => t.name === call.name)
          let result: unknown
          if (tool) {
            try {
              result = await tool.execute(call.params, {
                sessionId,
                agentDir: this.agentDir,
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
          }
          await this.sessionStore.append(sessionId, resultEvent)
          history.push(resultEvent)
        }
        // Continue loop to get model's next response
      } else {
        // No tool calls — final response
        continueLoop = false

        if (response.text) {
          const assistantEvent: Event = {
            id: randomUUID(),
            type: "assistant",
            ts: Date.now(),
            data: { text: response.text },
          }
          await this.sessionStore.append(sessionId, assistantEvent)
          await send(response.text)
        }
      }
    }

    this.sessionManager.touch(sessionId)
  }
}
