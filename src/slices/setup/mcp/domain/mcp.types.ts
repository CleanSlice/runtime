import type { IMcpServerConfig } from "../../../runtime/init"

export type { IMcpServerConfig }

/** Inputs for the McpService.loadAll() bootstrap step. */
export interface IMcpLoadOptions {
  /** Servers declared in agent.config.json — local / dev-time entries. */
  fromConfig: IMcpServerConfig[]
  /**
   * Raw JSON string containing an array of IMcpServerConfig objects, decoded
   * upstream from the `MCP_SERVERS_B64` env var that the deploy pipeline
   * populates (Ranch, custom k8s, docker-compose, …). Empty/undefined means
   * "no platform-managed servers, just the config file".
   */
  fromEnv?: string
}
