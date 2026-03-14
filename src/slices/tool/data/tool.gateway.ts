import type { IToolGateway } from "../domain/tool.gateway"
import type { Tool, ToolContext } from "../domain/tool.types"
import { ExecTool } from "./repositories/exec/exec.repository"
import { FileTool } from "./repositories/file/file.repository"
import { HttpTool } from "./repositories/http/http.repository"
import { BrowserTool } from "./repositories/browser/browser.repository"
import { BrowserScreenshotTool } from "./repositories/browser/screenshot.repository"
import { CronListRepository, CronAddRepository, CronRemoveRepository, CronDisableRepository } from "./repositories/cron/cron.repository"
import { WebSearchTool } from "./repositories/websearch/websearch.repository"
import { ImageAnalyzeTool } from "./repositories/image/image.repository"

export class ToolGateway implements IToolGateway {
  private tools: Map<string, Tool> = new Map()

  constructor() {
    this.register(ExecTool)
    this.register(FileTool)
    this.register(HttpTool)
    this.register(BrowserTool)
    this.register(BrowserScreenshotTool)
    this.register(CronListRepository as Tool)
    this.register(CronAddRepository as Tool)
    this.register(CronRemoveRepository as Tool)
    this.register(CronDisableRepository as Tool)
    this.register(WebSearchTool)
    this.register(ImageAnalyzeTool)
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
