import { AgentGateway } from "./data/agent.gateway"
import { AgentService } from "./domain/agent.service"
import type { SkillSummary } from "../skill/domain/skill.types"
import type { IBuiltPrompt } from "./domain/agent.types"
import type { MemoryLimits } from "../memory/domain/memory.types"

export type { IBuiltPrompt, IPromptBreakdown, IPromptSection, IOnDemandLoad, PromptSectionName } from "./domain/agent.types"
export { SECTION_SEPARATOR, SKILL_CATALOGUE_INSTRUCTIONS } from "./domain/agent.service"

export class AgentModule {
  private service: AgentService

  /**
   * `limits` (memory.limits) bounds the prompt copy of each curated file; the files on disk stay whole (CLEAN-207).
   * `exampleDir` lets the gateway leave a file that still reads as `.agent.example` shipped it out of the prompt (CLEAN-213).
   */
  constructor(private agentDir: string, limits?: MemoryLimits, exampleDir?: string) {
    this.service = new AgentService(new AgentGateway(exampleDir), limits)
  }

  async buildPrompt(opts?: { userId?: string; toolingPrompt?: string; secretKeys?: string[]; dailyMemory?: string; skills?: SkillSummary[]; isAdmin?: boolean; extraHint?: string; integratorPrompt?: string; channelContext?: string; citationsPrompt?: string; instincts?: string }): Promise<IBuiltPrompt> {
    return this.service.buildPrompt(this.agentDir, opts)
  }
}
