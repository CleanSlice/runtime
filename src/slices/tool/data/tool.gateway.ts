import type { IToolGateway } from "../domain/tool.gateway"
import type { Tool, ToolContext } from "../domain/tool.types"
import { ExecRepository } from "./repositories/exec/exec.repository"
import { FileRepository } from "./repositories/file/file.repository"
import { HttpRepository } from "./repositories/http/http.repository"
import { MessageRepository } from "./repositories/message/message.repository"

export class ToolGateway implements IToolGateway {
  private tools: Map<string, Tool> = new Map()

  constructor() {
    this.register(new ExecRepository())
    this.register(new FileRepository())
    this.register(new HttpRepository())
    this.register(new MessageRepository())
  }

  private register(tool: Tool): void {
    this.tools.set(tool.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  getAll(): Tool[] {
    return [...this.tools.values()]
  }

  async execute(name: string, params: unknown, ctx: ToolContext): Promise<unknown> {
    const tool = this.get(name)
    if (!tool) return { error: `Unknown tool: ${name}` }
    try {
      return await tool.execute(params, ctx)
    } catch (err) {
      return { error: String(err) }
    }
  }
}
