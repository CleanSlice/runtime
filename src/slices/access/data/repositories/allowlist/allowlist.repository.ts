import type { IAccessStrategy, AccessResult } from "../../../domain/access.types"
import type { IAccessGateway } from "../../../domain/access.gateway"

export class AllowlistRepository implements IAccessStrategy {
  name = "allowlist"

  constructor(private allowedIds: string[]) {}

  check(userId: string, _gateway: IAccessGateway, adminIds: string[]): AccessResult {
    const allowed = this.allowedIds.includes(userId) || adminIds.includes(userId)
    return { allowed, reason: allowed ? undefined : "Not on allowlist" }
  }
}
