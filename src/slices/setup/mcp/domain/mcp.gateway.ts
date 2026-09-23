import type { Tool } from "../../../agent/tool"
import type { IMcpServerConfig } from "./mcp.types"

/** What `reconnect` hands back after a login landed (CLEAN-79). */
export interface IMcpReconnectResult {
  serverName: string
  /**
   * The server's full tool set when this login made tools listable for the
   * first time (the registry swaps the connect-only surface for it); null
   * when the tools were already registered and only a client was opened.
   */
  tools: Tool[] | null
}

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
  /**
   * An OAuth login for `subject` just completed on Ranch (hub
   * `mcp_connected`, CLEAN-79/81): open their client in this session and,
   * if the server's tools were never listed, list them. Null when this
   * runtime does not run that server.
   */
  abstract reconnect(serverId: string, subject: string): Promise<IMcpReconnectResult | null>
  /** Close every open client. Called from graceful shutdown. */
  abstract closeAll(): Promise<void>
}
