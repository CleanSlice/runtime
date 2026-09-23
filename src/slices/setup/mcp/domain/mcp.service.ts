import type { Tool } from "../../../agent/tool"
import { IMcpGateway } from "./mcp.gateway"
import type { IMcpConnectedEvent, IMcpLoadOptions, IMcpServerConfig } from "./mcp.types"
import { McpFetcher } from "./mcp.fetcher"
import { createLogger } from "../../logger"

const log = createLogger("mcp")

/**
 * Orchestrates the boot-time MCP load:
 *  1. parses the platform-managed list (decoded from MCP_SERVERS_B64 env)
 *  2. merges with config-file entries (env wins on `name` collision)
 *  3. opens a client for each enabled entry
 *  4. returns the combined Tool[] for ToolGateway to register
 *
 * Failures are non-fatal: a bad MCP server logs a warning and is skipped,
 * the rest still load. Boot never aborts because of MCP issues.
 *
 * After boot it also applies `mcp_connected` (CLEAN-79): a login that just
 * landed brings the person's client up in the running session and, the
 * first time, swaps that server's connect-only tool for its real tools in
 * the live registry — no restart.
 */
export class McpService {
  constructor(
    private gateway: IMcpGateway,
    private fetcher: McpFetcher,
  ) {}

  async loadAll(opts: IMcpLoadOptions): Promise<Tool[]> {
    const fromEnv = this.fetcher.fromEnv(opts.fromEnv)
    const merged = this.mergeByName(opts.fromConfig, fromEnv)
    if (merged.length === 0) {
      log.info("no servers configured")
      return []
    }
    log.info(
      `connecting to ${merged.length} server(s): ${merged.map((m) => m.name).join(", ")}`,
    )
    const all: Tool[] = []
    for (const cfg of merged) {
      const tools = await this.gateway.connect(cfg)
      all.push(...tools)
    }
    log.info(`total ${all.length} tools registered from MCP servers`)
    return all
  }

  /**
   * Apply a login to the running session. `registry` is the live tool list
   * the runtime reads on every message (the same array `loadAll` fed), so
   * swapping entries in place is what makes the tools appear mid-session.
   * Returns how many tools are live for that server afterwards, or null
   * when the event was not for a server this runtime runs.
   */
  async handleConnected(event: IMcpConnectedEvent, registry: Tool[]): Promise<number | null> {
    const result = await this.gateway.reconnect(event.serverId, event.subject)
    if (!result) {
      log.debug(`mcp_connected for ${event.server} ignored — not one of this agent's servers`)
      return null
    }
    if (!result.tools) return countFor(registry, result.serverName)
    swapServerTools(registry, result.serverName, result.tools)
    return countFor(registry, result.serverName)
  }

  async shutdown(): Promise<void> {
    await this.gateway.closeAll()
  }

  /**
   * Merge by `name`. Env entries overwrite file entries — the orchestrator
   * is the managed source of truth, the config file is for local additions.
   * Logs overrides so it's visible when something gets shadowed.
   */
  private mergeByName(
    local: IMcpServerConfig[],
    env: IMcpServerConfig[],
  ): IMcpServerConfig[] {
    const map = new Map<string, IMcpServerConfig>()
    for (const m of local) map.set(m.name, m)
    for (const m of env) {
      if (map.has(m.name)) {
        log.info(`${m.name}: env entry overrides config-file entry`)
      }
      map.set(m.name, m)
    }
    return [...map.values()]
  }
}

const prefixOf = (serverName: string): string => `${serverName}__`

/**
 * Replace every `${serverName}__*` tool in the live registry with `next`, in
 * place. In place matters: the runtime and the loop hold this very array,
 * and a new array would be one they never see.
 */
export function swapServerTools(registry: Tool[], serverName: string, next: Tool[]): void {
  const prefix = prefixOf(serverName)
  for (let i = registry.length - 1; i >= 0; i--) {
    if (registry[i]!.name.startsWith(prefix)) registry.splice(i, 1)
  }
  registry.push(...next)
}

/** Tools live for a server, the connect tool excluded. */
export function countFor(registry: Tool[], serverName: string): number {
  const prefix = prefixOf(serverName)
  const connect = `${serverName}__connect`
  return registry.filter((t) => t.name.startsWith(prefix) && t.name !== connect).length
}
