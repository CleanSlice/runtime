import { randomUUID } from "crypto"
import type { IAccessStrategy, AccessResult, UserRecord } from "../../../domain/access.types"
import type { IAccessGateway } from "../../../domain/access.gateway"

export class CodeRepository implements IAccessStrategy {
  name = "code"

  constructor(private secretCode: string) {}

  check(userId: string, gateway: IAccessGateway, adminIds: string[]): AccessResult {
    if (adminIds.includes(userId)) return { allowed: true }
    const user = gateway.getUser(userId)
    if (!user) return { allowed: false, pendingAction: "enter_code" }
    if (user.status === "active" || user.status === "admin") return { allowed: true }
    return { allowed: false, pendingAction: "enter_code" }
  }

  onNewUser(userId: string, gateway: IAccessGateway): UserRecord {
    const existing = gateway.getUser(userId)
    if (existing) return existing
    const record: UserRecord = {
      userId,
      status: "pending",
      inviteCode: randomUUID().slice(0, 8),
      createdAt: Date.now(),
    }
    gateway.setUser(record)
    gateway.save()
    return record
  }

  handleInput(userId: string, input: string, gateway: IAccessGateway): {
    activated?: UserRecord
    alreadyActive?: boolean
  } {
    const user = gateway.getUser(userId)
    if (!user) return {}
    if (user.status === "active" || user.status === "admin") return { alreadyActive: true }
    if (input === this.secretCode) {
      user.status = "active"
      user.activatedAt = Date.now()
      gateway.setUser(user)
      gateway.save()
      return { activated: user }
    }
    return {}
  }
}
