import { AgentGateway } from "./data/agent.gateway"
import { AgentService } from "./domain/agent.service"

export class AgentModule {
  private service: AgentService

  constructor(private agentDir: string) {
    this.service = new AgentService(new AgentGateway())
  }

  async buildPrompt(opts?: { userId?: string; toolingPrompt?: string; secretKeys?: string[]; dailyMemory?: string }): Promise<string> {
    return this.service.buildPrompt(this.agentDir, opts)
  }
}
