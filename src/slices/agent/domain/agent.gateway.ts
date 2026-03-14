import type { AgentConfig } from "./agent.types"

export interface AgentGateway {
  load(agentDir: string): Promise<AgentConfig>
}
