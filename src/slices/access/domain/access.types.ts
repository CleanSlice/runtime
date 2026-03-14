import type { IAccessGateway } from "./access.gateway"

export type UserStatus = "active" | "pending" | "admin" | "blocked"

export interface UserRecord {
  userId: string
  status: UserStatus
  inviteCode: string
  invitedBy?: string
  activatedAt?: number
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface AccessResult {
  allowed: boolean
  reason?: string
  pendingAction?: string  // "invite_friend" | "enter_code"
}

export interface IAccessStrategy {
  name: string
  check(userId: string, gateway: IAccessGateway, adminIds: string[]): AccessResult
  onNewUser?(userId: string, gateway: IAccessGateway, input?: string): UserRecord
  handleInput?(userId: string, input: string, gateway: IAccessGateway): {
    activated?: UserRecord
    newUser?: UserRecord
    alreadyActive?: boolean
  }
  getInviteLink?(userId: string, gateway: IAccessGateway, botUsername: string): string
}
