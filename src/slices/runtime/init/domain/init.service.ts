import type { IInitGateway } from "./init.gateway"
import type { IAgentConfig } from "./init.types"

export class InitService {
  constructor(private gateway: IInitGateway) {}

  /** Bootstrap the agent directory and return loaded config */
  bootstrap(agentDir: string, exampleDir: string): IAgentConfig {
    this.gateway.scaffold(agentDir, exampleDir)
    return this.gateway.loadConfig(agentDir)
  }
}
