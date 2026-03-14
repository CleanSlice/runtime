import type { Tool, ToolContext } from "./tool.types"

export interface IToolGateway {
  get(name: string): Tool | undefined
  getAll(): Tool[]
  execute(name: string, params: unknown, ctx: ToolContext): Promise<unknown>
}
