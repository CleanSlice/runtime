import type { Skill, RegistryEntry } from "./skill.types"

export interface ISkillGateway {
  /** Load all skills from all sources (bundled + installed + agent) */
  loadAll(): Promise<Skill[]>

  /** Load a single skill by name */
  load(name: string): Promise<Skill | null>

  /** Install a skill from registry or GitHub URL into .agent/skills/ */
  install(nameOrUrl: string): Promise<Skill>

  /** Remove an installed skill from .agent/skills/ */
  remove(name: string): Promise<void>

  /** Search the remote skill registry */
  searchRegistry(query: string): Promise<RegistryEntry[]>

  /** Fetch and cache the remote registry */
  fetchRegistry(): Promise<RegistryEntry[]>
}
