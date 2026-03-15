import type { Skill } from "./domain/skill.types"
import { SkillService } from "./domain/skill.service"
import { SkillGateway } from "./data/skill.gateway"

export class SkillModule {
  private service: SkillService

  constructor(agentDir: string) {
    this.service = new SkillService(new SkillGateway(agentDir))
  }

  async load(): Promise<void> {
    await this.service.load()
  }

  getAll(): Skill[] {
    return this.service.getAll()
  }

  get(name: string): Skill | undefined {
    return this.service.get(name)
  }

  select(message: string): Skill | null {
    return this.service.select(message)
  }
}
