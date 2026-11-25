import { McpGateway } from "./data/mcp.gateway"
import type { ISecretStore } from "./data/mcpOauth.provider"
import { McpService, McpFetcher } from "./domain"
import type { IActor, IMcpConnectedEvent, IMcpLoadOptions, IToolState } from "./domain"
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

  /**
   * The tools of one turn (CLEAN-232): Ranch lists its tools per caller, so
   * its part of `tools` becomes what it lists for the turn's actor. Built-in
   * tools and other MCP servers pass through.
   */
  scopeTools(tools: Tool[], actor: IActor): Promise<Tool[]> {
    return this.service.scopeTools(tools, actor)
  }

  /**
   * Hand over the live registry (CLEAN-245): a server that did not answer is
   * tried again from here on, and its tools land in `registry` when it does.
   * Call before `loadAll`, with the array `loadAll`'s tools are pushed into.
   */
  bind(registry: Tool[]): void {
    this.service.bind(registry)
  }

  /** Before a turn: one attempt at the missing servers, waited for at most `budgetMs`. */
  settle(budgetMs: number): Promise<void> {
    return this.service.settle(budgetMs)
  }

  /** The tool servers now: phase, and each server's state. */
  state(): IToolState {
    return this.service.state()
  }

  /** Called whenever `state()` changes. Returns the unsubscribe. */
  onState(listener: (state: IToolState) => void): () => void {
    return this.service.onState(listener)
  }

  /** Tear down all MCP clients on shutdown. */
  shutdown(): Promise<void> {
    return this.service.shutdown()
  }
}
