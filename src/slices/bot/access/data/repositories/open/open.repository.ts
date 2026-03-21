import type { IAccessStrategy, AccessResult, UserRecord } from "../../../domain/access.types"
import type { IAccessGateway } from "../../../domain/access.gateway"

export class OpenRepository implements IAccessStrategy {
  name = "open"

  check(_userId: string, _gateway: IAccessGateway, _adminIds: string[]): AccessResult {
    return { allowed: true }
  }

  onNewUser(userId: string, gateway: IAccessGateway): UserRecord {
    const existing = gateway.getUser(userId)
    if (existing) return existing
    const record: UserRecord = {
      userId,
      status: "active",
      createdAt: Date.now(),
    }
    gateway.setUser(record)
    gateway.save()
    return record
  }
}
