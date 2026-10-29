import { LoopService } from "./domain/loop.service"
import type { ILoopConfig } from "./domain/loop.types"
import type { LlmModule } from "../../setup/llm/llm.module"
import type { SessionModule } from "../../agent/session/session.module"
import type { ActivityService } from "../../bot/activity/domain/activity.service"
import type { UsageModule } from "../../bot/usage/usage.module"
import type { VoiceModule } from "../../bot/voice/voice.module"
import type { ChannelModule } from "../../setup/channel/channel.module"
import type { Tool } from "../../agent/tool"
import type { SkillModule } from "../../agent/skill/skill.module"
import type { InstinctModule } from "../../agent/instinct/instinct.module"

export { DelegateService } from "./domain/delegate.service"
import type { DelegateService } from "./domain/delegate.service"
import type { TaskManager } from "../../agent/task/domain/task.service"

export { LoopService }
export type { ILoopContext, ILoopResult, ILoopConfig } from "./domain/loop.types"

interface LoopModuleDeps {
  llm: LlmModule
  session: SessionModule
  activity: ActivityService
  usage: UsageModule
  voice: VoiceModule
  channel: ChannelModule
  tools: Tool[]
  skills?: SkillModule
  instincts?: InstinctModule
  tasks?: TaskManager
}

export class LoopModule {
  readonly service: LoopService

  constructor(deps: LoopModuleDeps, config?: Partial<ILoopConfig>) {
    this.service = new LoopService(deps, config)
  }

  /** Wire delegation once the loop exists — workers run through this very loop (CLEAN-150 US6). */
  setDelegate(delegate: DelegateService): void {
    this.service.setDelegate(delegate)
  }

  /** Update maxIterations after construction (e.g. after an agent.config.json reload). */
  updateMaxIterations(maxIterations: number): void {
    this.service.updateMaxIterations(maxIterations)
  }
}
