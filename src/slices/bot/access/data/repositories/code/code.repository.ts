import type { IAccessStrategy, AccessResult, UserRecord } from "../../../domain/access.types"
import type { IAccessGateway } from "../../../domain/access.gateway"

export class CodeRepository implements IAccessStrategy {
  name = "code"

  constructor(private secretCode: string) {}

  check(userId: string, gateway: IAccessGateway, adminIds: string[]): AccessResult {
    if (adminIds.includes(userId)) return { allowed: true }
    const user = gateway.getUser(userId)
    if (!user) return { allowed: false, reason: "Not registered" }
    if (user.status === "active" || user.status === "admin") return { allowed: true }
    return { allowed: false, reason: "Pending activation" }
  }

  onNewUser(userId: string, gateway: IAccessGateway): UserRecord {
    const existing = gateway.getUser(userId)
    if (existing) return existing
    const record: UserRecord = {
      userId,
      status: "pending",
      createdAt: Date.now(),
    }
    gateway.setUser(record)
    gateway.save()
    return record
  }
}
