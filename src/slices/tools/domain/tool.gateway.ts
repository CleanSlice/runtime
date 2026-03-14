import type { Tool, ToolContext } from "./tool.types"

export interface ToolGateway {
  get(name: string): Tool | undefined
  getAll(): Tool[]
  execute(name: string, params: unknown, ctx: ToolContext): Promise<unknown>
}
