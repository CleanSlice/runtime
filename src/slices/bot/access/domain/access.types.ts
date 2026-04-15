import type { IAccessGateway } from "./access.gateway"

export type UserStatus = "active" | "pending" | "admin" | "blocked"

export type StrategyName = "open" | "public" | "allowlist" | "code" | "approval"

export interface UserRecord {
  userId: string
  status: UserStatus
  accessCode?: string
  activatedAt?: number
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface AccessResult {
  allowed: boolean
  reason?: string
}

export interface IAccessStrategy {
  name: string
  check(userId: string, gateway: IAccessGateway, adminIds: string[]): AccessResult
  onNewUser?(userId: string, gateway: IAccessGateway): UserRecord
}

/** Persisted runtime override of the access strategy (set via /access or set_access_strategy tool). */
export interface StrategyOverride {
  name: StrategyName
  allowlist?: string[]
  accessCode?: string
}
