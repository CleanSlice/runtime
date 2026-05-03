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
  /**
   * Zod schema describing the tool's params. Used both for runtime validation
   * (tool.execute receives `unknown`) and as the source for the LLM-facing
   * JSON Schema via `zodToJsonSchema`.
   *
   * For tools whose schema is already JSON Schema (e.g. MCP-imported tools),
   * use `z.any()` here and provide the JSON Schema via `inputSchema` — that
   * field takes precedence when serializing for the LLM.
   */
  schema: ZodSchema
  /**
   * Optional pre-built JSON Schema for the LLM. When set, takes precedence
   * over `zodToJsonSchema(schema)`. Use this when the schema comes from an
   * external source (MCP server, OpenAPI spec) and round-tripping it through
   * Zod would lose information.
   */
  inputSchema?: Record<string, unknown>
  /** When true, only admin users can call this tool. Mutating tools should be marked admin-only. */
  adminOnly?: boolean
  execute(params: unknown, ctx: ToolContext): Promise<unknown>
}
