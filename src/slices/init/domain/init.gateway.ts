import type { IAgentConfig } from "./init.types"

/** Gateway contract for init slice */
export interface IInitGateway {
  /** Scaffold agent directory from example if not yet initialized */
  scaffold(agentDir: string, exampleDir: string): void

  /** Load agent.config.json merged with defaults */
  loadConfig(agentDir: string): IAgentConfig
}
