import type { ZodSchema } from "zod"

export interface ToolContext {
  sessionId: string
  agentDir: string
  from?: string   // chat id (e.g. Telegram user id)
  channel?: string
  send: (text: string) => Promise<void>
}

export interface Tool {
  name: string
  description: string
  schema: ZodSchema
  execute(params: unknown, ctx: ToolContext): Promise<unknown>
}
