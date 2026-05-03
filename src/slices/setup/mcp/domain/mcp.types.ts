import type { IMcpServerConfig } from "../../../runtime/init"

export type { IMcpServerConfig }

/** Inputs for the McpService.loadAll() bootstrap step. */
export interface IMcpLoadOptions {
  /** Servers declared in agent.config.json — local / dev-time entries. */
  fromConfig: IMcpServerConfig[]
  /**
   * Raw JSON string from a single env var (e.g. `MCP_SERVERS`) containing an
   * array of IMcpServerConfig objects. The deploy pipeline of whatever
   * platform hosts the runtime (Ranch, custom k8s, docker-compose, …) is
   * expected to populate it. Empty/undefined means "no platform-managed
   * servers, just the config file".
   */
  fromEnv?: string
}
