import type { ISkillGateway } from "../domain/skill.gateway"
import type { Skill } from "../domain/skill.types"
import { existsSync, readdirSync } from "fs"
import { join } from "path"
import matter from "gray-matter"

export class SkillGateway implements ISkillGateway {
  private skillsDir: string

  constructor(agentDir: string) {
    this.skillsDir = join(agentDir, "skills")
  }

  async loadAll(): Promise<Skill[]> {
    if (!existsSync(this.skillsDir)) return []

    const skills: Skill[] = []
    const entries = readdirSync(this.skillsDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const skillPath = join(this.skillsDir, entry.name, "SKILL.md")
      const skill = await this.load(entry.name)
      if (skill) skills.push(skill)
    }

    return skills
  }

  async load(name: string): Promise<Skill | null> {
    const skillPath = join(this.skillsDir, name, "SKILL.md")
    if (!existsSync(skillPath)) return null

    try {
      const raw = await Bun.file(skillPath).text()
      const { data, content } = matter(raw)

      return {
        name: (data.name as string) ?? name,
        description: (data.description as string) ?? "",
        path: skillPath,
        content: content.trim(),
      }
    } catch {
      return null
    }
  }
}
