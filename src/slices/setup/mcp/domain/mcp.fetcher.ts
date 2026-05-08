import type { IMcpServerConfig } from "./mcp.types"

/**
 * Parses platform-managed MCP servers from a JSON env var. Pure parsing:
 * no I/O, no connection logic. Whatever orchestrator (Ranch, k8s, compose)
 * hosts the runtime is responsible for serializing the list there.
 *
 * On any failure (missing var, malformed JSON, wrong shape) returns []. Boot
 * continues with whatever was declared in agent.config.json so a bad
 * deployment env never grounds the agent.
 */
export class McpFetcher {
  fromEnv(json: string | undefined | null): IMcpServerConfig[] {
    if (!json) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch (err) {
      console.warn(
        "[mcp] MCP_SERVERS_B64 env is not valid JSON — ignoring:",
        err,
      )
      return []
    }
    if (!Array.isArray(parsed)) {
      console.warn(
        `[mcp] MCP_SERVERS_B64 env: expected array, got ${typeof parsed} — ignoring`,
      )
      return []
    }
    return parsed as IMcpServerConfig[]
  }
}
