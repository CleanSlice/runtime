import type { UserRecord, StrategyOverride } from "./access.types"

export interface IAccessGateway {
  getUser(userId: string): UserRecord | undefined
  setUser(user: UserRecord): void
  getAllUsers(): UserRecord[]
  getStrategyOverride(): StrategyOverride | undefined
  setStrategyOverride(override: StrategyOverride | undefined): void
  load(): void
  save(): void
}
