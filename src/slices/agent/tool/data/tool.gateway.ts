import type { IToolGateway } from "../domain/tool.gateway"
import type { Tool, ToolContext } from "../domain/tool.types"
import { ExecTool } from "./repositories/exec/exec.repository"
import { FileTool } from "./repositories/file/file.repository"
import { UnzipTool } from "./repositories/file/unzip.repository"
import { HttpTool } from "./repositories/http/http.repository"
import { BrowserTool } from "./repositories/browser/browser.repository"

import { BrowserScreenshotTool } from "./repositories/browser/screenshot.repository"
import { PlaywrightTool } from "./repositories/browser/playwright.repository"
// browser_login + browser_login_done were the legacy noVNC/pool flow.
// Replaced by session_request_login below — agent forwards a help
// URL the user opens, and pushes cookies via the Ranch extension.
// Imports kept on disk (for the rare standalone agent that still needs
// them) but no longer registered in the runtime tool registry.
import { CronListRepository, CronAddRepository, CronRemoveRepository, CronDisableRepository } from "./repositories/cron/cron.repository"
import { WebSearchTool } from "./repositories/websearch/websearch.repository"
import { WebFetchTool } from "./repositories/websearch/webfetch.repository"
import { ImageAnalyzeTool } from "./repositories/image/image.repository"
import { PdfAnalyzeTool } from "./repositories/image/pdf.repository"
import { TelegramSendTool } from "./repositories/message/telegram_send.repository"
import { TtsTool } from "./repositories/message/tts.repository"
import { MemorySearchTool } from "./repositories/memory/memory_search.repository"
import { MemorySaveTool } from "./repositories/memory/memory_save.repository"
import { ProcessExecTool } from "./repositories/exec/process.repository"
import { SpawnAgentTool } from "./repositories/exec/spawn_agent.repository"
import { SecretSetTool, SecretGetTool, SecretListTool, SecretDeleteTool } from "./repositories/secret/secret.repository"
import { ChannelTelegramSetTool, ChannelRemoveTool, ChannelListTool } from "./repositories/channel/channel.repository"
import { ApproveUserTool } from "./repositories/access/approve.repository"
import { SetAccessStrategyTool } from "./repositories/access/set_strategy.repository"
import { SkillWriteTool } from "./repositories/skill/skill.repository"
import { SessionSecretsTool } from "./repositories/session/session_secrets.repository"
import { SessionRequestLoginTool } from "./repositories/session/session_request_login.repository"
import { SessionListTool } from "./repositories/session/session_list.repository"
import { ResourceStatusTool } from "./repositories/resource/resource_status.repository"

export class ToolGateway implements IToolGateway {
  private tools: Map<string, Tool> = new Map()

  constructor() {
    this.register(ExecTool)
    this.register(FileTool)
    this.register(UnzipTool)
    this.register(HttpTool)
    this.register(BrowserTool)
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
    this.register(MemorySaveTool)
    this.register(ProcessExecTool)
    this.register(SpawnAgentTool)
    this.register(SecretSetTool)
    this.register(SecretGetTool)
    this.register(SecretListTool)
    this.register(SecretDeleteTool)
    this.register(ChannelTelegramSetTool)
    this.register(ChannelRemoveTool)
    this.register(ChannelListTool)
    this.register(ApproveUserTool)
    this.register(SetAccessStrategyTool)
    this.register(SkillWriteTool)
    this.register(SessionSecretsTool)
    this.register(SessionRequestLoginTool)
    this.register(SessionListTool)
    this.register(ResourceStatusTool)
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
