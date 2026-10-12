import type { IInstinct } from "./instinct.types"

export interface IInstinctGateway {
  /** Every persisted behaviour. Malformed files are skipped (and logged once by the gateway). */
  list(): IInstinct[]
  write(instinct: IInstinct): void
  remove(id: string): void
  /** When decay last ran, or undefined. */
  readLastDecay(): number | undefined
  writeLastDecay(ts: number): void
  /** Write a promoted skill (`skills/learned-<slug>/SKILL.md`). Returns the file path. */
  writeSkill(slug: string, description: string, content: string): string
}
