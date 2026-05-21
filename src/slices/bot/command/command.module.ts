import { CommandService } from "./domain/command.service"
import type { AccessModule } from "../access/access.module"
import type { SkillModule } from "../../agent/skill/skill.module"
import type { VoiceModule } from "../voice/voice.module"
import type { TaskManager } from "../../agent/task/domain/task.service"
import type { SessionModule } from "../../agent/session/session.module"
import type { MemoryModule } from "../../agent/memory/memory.module"
import type { LlmModule } from "../../setup/llm/llm.module"

export { CommandService }
export type { ICommandContext, ICommandResult } from "./domain/command.types"

interface CommandModuleDeps {
  access: AccessModule
  skills: SkillModule
  voice: VoiceModule
  tasks: TaskManager
  session: SessionModule
  memory: MemoryModule
  llm: LlmModule
}

export class CommandModule {
  readonly service: CommandService

  constructor(deps: CommandModuleDeps) {
    this.service = new CommandService(deps)
  }
}
