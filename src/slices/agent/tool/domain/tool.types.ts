import type { ZodSchema } from "zod"
import type { IAgentConfig } from "../../init"

export interface ToolContext {
  sessionId: string
  agentDir: string
  from?: string   // chat id (e.g. Telegram user id)
  channel?: string
  send: (text: string) => Promise<void>
  agentConfig?: IAgentConfig
}

export interface Tool {
  name: string
  description: string
  schema: ZodSchema
  execute(params: unknown, ctx: ToolContext): Promise<unknown>
}
