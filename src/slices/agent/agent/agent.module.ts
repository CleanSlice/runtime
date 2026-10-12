import { AgentGateway } from "./data/agent.gateway"
import { AgentService } from "./domain/agent.service"
import type { SkillSummary } from "../skill/domain/skill.types"
import type { IBuiltPrompt } from "./domain/agent.types"

export type { IBuiltPrompt, IPromptBreakdown, IPromptSection, IOnDemandLoad, PromptSectionName } from "./domain/agent.types"
export { SECTION_SEPARATOR, SKILL_CATALOGUE_INSTRUCTIONS } from "./domain/agent.service"

export class AgentModule {
  private service: AgentService

  constructor(private agentDir: string) {
    this.service = new AgentService(new AgentGateway())
  }

  async buildPrompt(opts?: { userId?: string; toolingPrompt?: string; secretKeys?: string[]; dailyMemory?: string; skills?: SkillSummary[]; isAdmin?: boolean; extraHint?: string; integratorPrompt?: string; channelContext?: string }): Promise<IBuiltPrompt> {
    return this.service.buildPrompt(this.agentDir, opts)
  }
}
