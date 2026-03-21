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

  registerPending(userId: string): UserRecord {
    if (this.strategy.onNewUser) {
      return this.strategy.onNewUser(userId, this.gateway)
    }
    const existing = this.gateway.getUser(userId)
    if (existing) return existing
    const record: UserRecord = {
      userId,
      status: "pending",
      createdAt: Date.now(),
    }
    this.gateway.setUser(record)
    this.gateway.save()
    return record
  }

  getUser(userId: string): UserRecord | undefined {
    return this.gateway.getUser(userId)
  }

  /** Admin approves a pending user by their access code. Returns the activated user or undefined. */
  approve(code: string): UserRecord | undefined {
    this.gateway.load()
    const users = this.gateway.getAllUsers()
    const user = users.find(u => u.accessCode === code && u.status === "pending")
    if (!user) return undefined
    user.status = "active"
    user.activatedAt = Date.now()
    this.gateway.setUser(user)
    this.gateway.save()
    return user
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
