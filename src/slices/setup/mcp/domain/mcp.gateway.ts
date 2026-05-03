import type { Tool } from "../../../agent/tool"
import type { IMcpServerConfig } from "./mcp.types"

/**
 * Abstract gateway — opens MCP connections, lists their tools, and lets the
 * service tear them down on shutdown. The concrete implementation lives in
 * data/mcp.gateway.ts and uses @modelcontextprotocol/sdk under the hood.
 */
export abstract class IMcpGateway {
  /**
   * Connect to a single MCP server and return its tools wrapped as runtime
   * `Tool` objects. Tool names are namespaced as `${cfg.name}__${toolName}`.
   * Returns `[]` (and logs) if the connection fails — runtime continues
   * without that MCP rather than aborting boot.
   */
  abstract connect(cfg: IMcpServerConfig): Promise<Tool[]>

  /** Close every open client. Called from graceful shutdown. */
  abstract closeAll(): Promise<void>
}
