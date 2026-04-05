import type { ZodSchema } from "zod"
import type { IAgentConfig } from "../../../runtime/init"

export interface ToolContext {
  sessionId: string
  agentDir: string
  from?: string   // chat id (e.g. Telegram user id)
  channel?: string
  send: (text: string) => Promise<void>
  agentConfig?: IAgentConfig
  reloadSkills?: () => Promise<void>  // hot-reload skills after skill_write
}

export interface Tool {
  name: string
  description: string
  schema: ZodSchema
  execute(params: unknown, ctx: ToolContext): Promise<unknown>
}
