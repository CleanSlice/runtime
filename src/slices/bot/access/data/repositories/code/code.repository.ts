import type { IAccessStrategy, AccessResult, UserRecord } from "../../../domain/access.types"
import type { IAccessGateway } from "../../../domain/access.gateway"

/**
 * Code-based access: users must send the secret code to get access.
 * The bot should check incoming messages for the code and call activate(userId, code, gateway).
 */
export class CodeRepository implements IAccessStrategy {
  name = "code"

  constructor(private secretCode: string) {}

  check(userId: string, gateway: IAccessGateway, adminIds: string[]): AccessResult {
    if (adminIds.includes(userId)) return { allowed: true }
    const user = gateway.getUser(userId)
    if (!user) return { allowed: false, reason: "Send the access code to get started" }
    if (user.status === "active" || user.status === "admin") return { allowed: true }
    return { allowed: false, reason: "Send the access code to get started" }
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

  /**
   * Attempt to activate a user with the given code.
   * Returns the activated record on success, undefined if code is wrong.
   */
  activate(userId: string, code: string, gateway: IAccessGateway): UserRecord | undefined {
    if (code.trim() !== this.secretCode) return undefined
    const user = gateway.getUser(userId)
    const record: UserRecord = user ?? {
      userId,
      status: "pending",
      createdAt: Date.now(),
    }
    record.status = "active"
    record.activatedAt = Date.now()
    gateway.setUser(record)
    gateway.save()
    return record
  }

  isCode(text: string): boolean {
    return text.trim() === this.secretCode
  }
}
