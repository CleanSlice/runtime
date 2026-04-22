import type { IAccessGateway } from "./access.gateway"
import type { IAccessStrategy, StrategyOverride, UserRecord } from "./access.types"

export type StrategyBuilder = (override: StrategyOverride) => IAccessStrategy

export class AccessService {
  constructor(
    private gateway: IAccessGateway,
    private strategy: IAccessStrategy,
    private adminIds: string[],
    private rebuildStrategy?: StrategyBuilder,
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
    this.syncStrategyFromDisk()
    const result = this.strategy.check(userId, this.gateway, this.adminIds)
    if (!result.allowed) console.log(`[access] denied: ${userId}`)
    return result.allowed
  }

  registerPending(userId: string): UserRecord {
    this.gateway.load()
    this.syncStrategyFromDisk()
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

  getStrategyName(): string {
    return this.strategy.name
  }

  /** Replace the active strategy and persist it as a runtime override. */
  setStrategy(impl: IAccessStrategy, override: StrategyOverride): void {
    this.strategy = impl
    this.gateway.setStrategyOverride(override)
    this.gateway.save()
  }

  /** Re-read the persisted override and swap the in-memory strategy if it drifted. */
  reload(): void {
    this.gateway.load()
    this.syncStrategyFromDisk()
  }

  /**
   * If the persisted override disagrees with the current in-memory strategy,
   * rebuild it. Covers S3 restore at boot, auto-sync at runtime, and manual
   * edits to access.json — without requiring a process restart.
   */
  private syncStrategyFromDisk(): void {
    if (!this.rebuildStrategy) return
    const override = this.gateway.getStrategyOverride()
    if (!override || override.name === this.strategy.name) return
    this.strategy = this.rebuildStrategy(override)
    console.log(`[access] strategy reloaded from disk → "${override.name}"`)
  }
}
