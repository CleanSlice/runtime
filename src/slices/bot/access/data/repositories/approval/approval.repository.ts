import { randomUUID } from "crypto"
import type { IAccessStrategy, AccessResult, UserRecord } from "../../../domain/access.types"
import type { IAccessGateway } from "../../../domain/access.gateway"

/**
 * Approval-based access: new users get a code, admin approves via /approve <code>.
 */
export class ApprovalRepository implements IAccessStrategy {
  name = "approval"

  check(userId: string, gateway: IAccessGateway, adminIds: string[]): AccessResult {
    if (adminIds.includes(userId)) return { allowed: true }
    const user = gateway.getUser(userId)
    if (!user) return { allowed: false, reason: "Not registered" }
    if (user.status === "active" || user.status === "admin") return { allowed: true }
    return { allowed: false, reason: "Pending approval" }
  }

  onNewUser(userId: string, gateway: IAccessGateway): UserRecord {
    const existing = gateway.getUser(userId)
    if (existing) return existing
    const record: UserRecord = {
      userId,
      status: "pending",
      accessCode: randomUUID().slice(0, 6).toUpperCase(),
      createdAt: Date.now(),
    }
    gateway.setUser(record)
    gateway.save()
    return record
  }
}
