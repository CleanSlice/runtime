import { LoopService } from "./domain/loop.service"
import type { ILoopConfig } from "./domain/loop.types"
import type { LlmModule } from "../../setup/llm/llm.module"
import type { SessionModule } from "../../agent/session/session.module"
import type { ActivityService } from "../../bot/activity/domain/activity.service"
import type { UsageModule } from "../../bot/usage/usage.module"
import type { VoiceModule } from "../../bot/voice/voice.module"
import type { Tool } from "../../agent/tool"

export { LoopService }
export type { ILoopContext, ILoopResult, ILoopConfig } from "./domain/loop.types"

interface LoopModuleDeps {
  llm: LlmModule
  session: SessionModule
  activity: ActivityService
  usage: UsageModule
  voice: VoiceModule
  tools: Tool[]
}

export class LoopModule {
  readonly service: LoopService

  constructor(deps: LoopModuleDeps, config?: Partial<ILoopConfig>) {
    this.service = new LoopService(deps, config)
  }
}
