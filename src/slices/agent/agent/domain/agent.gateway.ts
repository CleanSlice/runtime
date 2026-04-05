import type { AgentConfig } from "./agent.types"

export interface IAgentGateway {
  load(agentDir: string): Promise<AgentConfig>
  loadUserContext(agentDir: string, userId: string): Promise<string | undefined>
}
