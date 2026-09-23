import { McpGateway } from "./data/mcp.gateway"
import type { ISecretStore } from "./data/mcpOauth.provider"
import { McpService, McpFetcher } from "./domain"
import type { IMcpConnectedEvent, IMcpLoadOptions } from "./domain"
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

  /**
   * A login landed on Ranch (hub `mcp_connected`, CLEAN-79): bring the
   * person's client up now and make the server's tools live in `registry`
   * — the array the runtime was handed — without a restart.
   */
  handleConnected(event: IMcpConnectedEvent, registry: Tool[]): Promise<number | null> {
    return this.service.handleConnected(event, registry)
  }

  /** Tear down all MCP clients on shutdown. */
  shutdown(): Promise<void> {
    return this.service.shutdown()
  }
}
