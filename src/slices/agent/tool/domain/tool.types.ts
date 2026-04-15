import type { ZodSchema } from "zod"
import type { IAgentConfig } from "../../../runtime/init"
import type { AccessModule } from "../../../bot/access/access.module"

export interface ToolContext {
  sessionId: string
  agentDir: string
  from?: string   // chat id (e.g. Telegram user id)
  channel?: string
  send: (text: string) => Promise<void>
  agentConfig?: IAgentConfig
  reloadSkills?: () => Promise<void>  // hot-reload skills after skill_write
  access?: AccessModule
  isAdmin?: boolean
}

export interface Tool {
  name: string
  description: string
  schema: ZodSchema
  /** When true, only admin users can call this tool. Mutating tools should be marked admin-only. */
  adminOnly?: boolean
  execute(params: unknown, ctx: ToolContext): Promise<unknown>
}
