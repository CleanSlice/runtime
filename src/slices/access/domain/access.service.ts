import { randomUUID } from "crypto"
import type { IAccessGateway } from "./access.gateway"
import type { IAccessStrategy, UserRecord } from "./access.types"

export class AccessService {
  constructor(
    private gateway: IAccessGateway,
    private strategy: IAccessStrategy,
    private adminIds: string[],
  ) {
    // Ensure admins always exist
    for (const id of adminIds) {
      if (!this.gateway.getUser(id)) {
        this.gateway.setUser({
          userId: id,
          status: "admin",
          inviteCode: randomUUID().slice(0, 8),
          createdAt: Date.now(),
        })
        this.gateway.save()
      }
    }
  }

  isAdmin(userId: string): boolean {
    return this.adminIds.includes(userId)
  }

  isAllowed(userId: string): boolean {
    this.gateway.load()
    const result = this.strategy.check(userId, this.gateway, this.adminIds)
    console.log(`[access] isAllowed(${userId}) = ${result.allowed}`)
    return result.allowed
  }

  processInvite(newUserId: string, code: string): {
    activated?: UserRecord
    newUser?: UserRecord
    alreadyActive?: boolean
  } {
    if (!this.strategy.handleInput) return {}
    return this.strategy.handleInput(newUserId, code, this.gateway)
  }

  getInviteLink(userId: string, botUsername: string): string {
    if (!this.strategy.getInviteLink) return ""
    return this.strategy.getInviteLink(userId, this.gateway, botUsername)
  }

  registerPending(userId: string): UserRecord {
    if (this.strategy.onNewUser) {
      return this.strategy.onNewUser(userId, this.gateway)
    }
    const existing = this.gateway.getUser(userId)
    if (existing) return existing
    const record: UserRecord = {
      userId,
      status: "pending",
      inviteCode: randomUUID().slice(0, 8),
      createdAt: Date.now(),
    }
    this.gateway.setUser(record)
    this.gateway.save()
    return record
  }

  getUser(userId: string): UserRecord | undefined {
    return this.gateway.getUser(userId)
  }

  stats(): { total: number; active: number; pending: number } {
    const users = this.gateway.getAllUsers()
    return {
      total: users.length,
      active: users.filter(u => u.status === "active" || u.status === "admin").length,
      pending: users.filter(u => u.status === "pending").length,
    }
  }
}
