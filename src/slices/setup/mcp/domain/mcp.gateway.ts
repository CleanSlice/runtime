import type { Tool } from "../../../agent/tool"
import type { IMcpServerConfig } from "./mcp.types"
import type { IActor } from "./actor"
import type { IToolServerState } from "./toolState"

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
   * without that MCP rather than aborting boot. The server stays known:
   * `status()` lists it as `retrying` (or `refused`) and `attempt()` tries
   * it again (CLEAN-245).
   */
  abstract connect(cfg: IMcpServerConfig): Promise<Tool[]>
  /**
   * Try a server that is not connected, now. Its tools when it answered;
   * null when it did not, was refused, or is not one of this agent's.
   */
  attempt(_name: string): Promise<Tool[] | null> {
    return Promise.resolve(null)
  }
  /** Every bearer/header/none server this agent runs, connected or not. */
  status(): IToolServerState[] {
    return []
  }
  /** Called after every change of a server's state, attempt count or error. Returns the unsubscribe. */
  onChange(_listener: () => void): () => void {
    return () => undefined
  }
  /**
   * An OAuth login for `subject` just completed on Ranch (hub
   * `mcp_connected`, CLEAN-79/81): open their client in this session and,
   * if the server's tools were never listed, list them. Null when this
   * runtime does not run that server.
   */
  abstract reconnect(serverId: string, subject: string): Promise<IMcpReconnectResult | null>
  /**
   * One turn's tools (CLEAN-232): for a server that lists per caller, its
   * tools in `tools` become exactly what it lists for `actor`; everything
   * else passes through. A gateway with no such server returns `tools`.
   */
  async scopeTools(tools: Tool[], _actor: IActor): Promise<Tool[]> {
    return tools
  }
  /** Close every open client. Called from graceful shutdown. */
  abstract closeAll(): Promise<void>
}
