import type { Skill } from "./skill.types"

export interface ISkillGateway {
  loadAll(): Promise<Skill[]>
  load(name: string): Promise<Skill | null>
}
