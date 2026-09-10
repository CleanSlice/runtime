import { McpGateway } from "./data/mcp.gateway"
import type { ISecretStore } from "./data/mcpOauth.provider"
import { McpService, McpFetcher } from "./domain"
import type { IMcpLoadOptions } from "./domain"
import type { Tool } from "../../agent/tool"

/**
 * Public entry point for MCP integration. Kept thin — most logic is in the
 * service. Mirrors the LlmModule shape so wiring in `index.ts` looks the
 * same for every setup slice.
 */
export class McpModule {
  private readonly service: McpService

  /** @param secrets per-agent secret store — needed for `oauth` MCP servers. */
  constructor(secrets?: ISecretStore) {
    this.service = new McpService(new McpGateway(secrets), new McpFetcher())
  }

  /** Boot-time load. Returns Tool[] for ToolGateway. */
  loadAll(opts: IMcpLoadOptions): Promise<Tool[]> {
    return this.service.loadAll(opts)
  }

  /** Tear down all MCP clients on shutdown. */
  shutdown(): Promise<void> {
    return this.service.shutdown()
  }
}
