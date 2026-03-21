import type { AgentConfig } from "./agent.types"

export interface IAgentGateway {
  load(agentDir: string): Promise<AgentConfig>
}
