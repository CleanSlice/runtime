import { AgentGateway } from "./data/agent.gateway"
import { AgentService } from "./domain/agent.service"

export class AgentModule {
  private service: AgentService

  constructor(private agentDir: string) {
    this.service = new AgentService(new AgentGateway())
  }

  async buildPrompt(): Promise<string> {
    return this.service.buildPrompt(this.agentDir)
  }
}
