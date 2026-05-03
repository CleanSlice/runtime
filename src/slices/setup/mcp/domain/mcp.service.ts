import type { Tool } from "../../../agent/tool"
import { IMcpGateway } from "./mcp.gateway"
import type { IMcpLoadOptions, IMcpServerConfig } from "./mcp.types"
import { McpFetcher } from "./mcp.fetcher"

/**
 * Orchestrates the boot-time MCP load:
 *  1. parses the platform-managed list from the MCP_SERVERS env (if set)
 *  2. merges with config-file entries (env wins on `name` collision)
 *  3. opens a client for each enabled entry
 *  4. returns the combined Tool[] for ToolGateway to register
 *
 * Failures are non-fatal: a bad MCP server logs a warning and is skipped,
 * the rest still load. Boot never aborts because of MCP issues.
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
      console.log("[mcp] no servers configured")
      return []
    }

    console.log(
      `[mcp] connecting to ${merged.length} server(s): ${merged.map((m) => m.name).join(", ")}`,
    )

    const all: Tool[] = []
    for (const cfg of merged) {
      const tools = await this.gateway.connect(cfg)
      all.push(...tools)
    }
    console.log(`[mcp] total ${all.length} tools registered from MCP servers`)
    return all
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
        console.log(`[mcp] ${m.name}: env entry overrides config-file entry`)
      }
      map.set(m.name, m)
    }
    return [...map.values()]
  }
}
