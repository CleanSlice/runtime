import type { IToolGateway } from "../domain/tool.gateway"
import type { Tool, ToolContext } from "../domain/tool.types"
import { ExecTool } from "./repositories/exec/exec.repository"
import { FileTool } from "./repositories/file/file.repository"
import { HttpTool } from "./repositories/http/http.repository"
import { BrowserTool } from "./repositories/browser/browser.repository"
import { InviteTool } from "./repositories/access/invite.repository"
import { BrowserScreenshotTool } from "./repositories/browser/screenshot.repository"
import { PlaywrightTool } from "./repositories/browser/playwright.repository"
import { CronListRepository, CronAddRepository, CronRemoveRepository, CronDisableRepository } from "./repositories/cron/cron.repository"
import { WebSearchTool } from "./repositories/websearch/websearch.repository"
import { WebFetchTool } from "./repositories/websearch/webfetch.repository"
import { ImageAnalyzeTool } from "./repositories/image/image.repository"
import { PdfAnalyzeTool } from "./repositories/image/pdf.repository"
import { TelegramSendTool } from "./repositories/message/telegram_send.repository"
import { TtsTool } from "./repositories/message/tts.repository"
import { MemorySearchTool } from "./repositories/memory/memory_search.repository"
import { ProcessExecTool } from "./repositories/exec/process.repository"
import { SpawnAgentTool } from "./repositories/exec/spawn_agent.repository"
import { SecretSetTool, SecretGetTool, SecretListTool, SecretDeleteTool } from "./repositories/secret/secret.repository"

export class ToolGateway implements IToolGateway {
  private tools: Map<string, Tool> = new Map()

  constructor() {
    this.register(ExecTool)
    this.register(FileTool)
    this.register(HttpTool)
    this.register(BrowserTool)
    this.register(InviteTool)
    this.register(BrowserScreenshotTool)
    this.register(PlaywrightTool)
    this.register(CronListRepository as Tool)
    this.register(CronAddRepository as Tool)
    this.register(CronRemoveRepository as Tool)
    this.register(CronDisableRepository as Tool)
    this.register(WebSearchTool)
    this.register(WebFetchTool)
    this.register(ImageAnalyzeTool)
    this.register(PdfAnalyzeTool)
    this.register(TelegramSendTool)
    this.register(TtsTool)
    this.register(MemorySearchTool)
    this.register(ProcessExecTool)
    this.register(SpawnAgentTool)
    this.register(SecretSetTool)
    this.register(SecretGetTool)
    this.register(SecretListTool)
    this.register(SecretDeleteTool)
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
