import type { Tool } from "./slices/tool"
import type { Event } from "./slices/event"
import type { ChannelGatewayConfig } from "../channel"
import type { LlmGatewayConfig } from "./slices/llm/llm.module"
import { ChannelModule } from "./slices/channel/channel.module"
import { SessionModule } from "./slices/session/session.module"
import { AgentModule } from "./slices/agent/agent.module"
import { MemoryModule } from "./slices/memory/memory.module"
import { CronModule } from "./slices/cron/cron.module"
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

  constructor(config: RuntimeConfig) {
    this.agentDir = config.agentDir ?? ".agent"
    this.tools = config.tools ?? []

    this.llm = new LlmModule(config.llm)
    this.channel = new ChannelModule(config.channels)
    this.session = new SessionModule(this.agentDir)
    this.agent = new AgentModule(this.agentDir)
    this.memory = new MemoryModule(this.agentDir)
    this.cron = new CronModule(this.agentDir)
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
  }

  async stop(): Promise<void> {
    await this.channel.stop()
    this.cron.stop()
  }

  async handleMessage(msg: { id: string; text: string; from: string; channel: string; ts: number; sessionId: string }): Promise<void> {
    console.log(`[msg] from=${msg.from} channel=${msg.channel} text="${msg.text}"`)
    try {
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

    const systemPrompt = await this.agent.buildPrompt()
    const history = await this.session.read(sessionId)

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
