import type { IAccessStrategy, AccessResult, UserRecord } from "../../../domain/access.types"
import type { IAccessGateway } from "../../../domain/access.gateway"

export class AllowlistRepository implements IAccessStrategy {
  name = "allowlist"

  constructor(private allowedIds: string[]) {}

  check(userId: string, _gateway: IAccessGateway, adminIds: string[]): AccessResult {
    const allowed = this.allowedIds.includes(userId) || adminIds.includes(userId)
    return { allowed, reason: allowed ? undefined : "Not on allowlist" }
  }

  onNewUser(userId: string, _gateway: IAccessGateway): UserRecord {
    // Allowlist strategy: don't persist users to access.json (allowedIds is the source of truth)
    const status = this.allowedIds.includes(userId) ? "active" : "pending"
    return {
      userId,
      status,
      createdAt: Date.now(),
    }
  }
}
