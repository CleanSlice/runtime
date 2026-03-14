import { randomUUID } from "crypto"
import type { IAccessStrategy, AccessResult, UserRecord } from "../../../domain/access.types"
import type { IAccessGateway } from "../../../domain/access.gateway"

export class InviteRepository implements IAccessStrategy {
  name = "invite"

  check(userId: string, gateway: IAccessGateway, adminIds: string[]): AccessResult {
    if (adminIds.includes(userId)) return { allowed: true }
    const user = gateway.getUser(userId)
    if (!user) return { allowed: false, pendingAction: "invite_friend" }
    if (user.status === "active" || user.status === "admin") return { allowed: true }
    return { allowed: false, pendingAction: "invite_friend" }
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

  handleInput(newUserId: string, inviteCode: string, gateway: IAccessGateway): {
    activated?: UserRecord
    newUser?: UserRecord
    alreadyActive?: boolean
  } {
    const inviter = gateway.getAllUsers().find(u => u.inviteCode === inviteCode)

    let newUser = gateway.getUser(newUserId)
    if (!newUser) {
      newUser = {
        userId: newUserId,
        status: "pending",
        inviteCode: randomUUID().slice(0, 8),
        invitedBy: inviter?.userId,
        createdAt: Date.now(),
      }
      gateway.setUser(newUser)
    }

    if (!inviter) {
      gateway.save()
      return { newUser }
    }

    if (inviter.status === "pending") {
      inviter.status = "active"
      inviter.activatedAt = Date.now()
      gateway.setUser(inviter)
      gateway.save()
      return { activated: inviter, newUser }
    }

    gateway.save()
    return { activated: inviter, newUser, alreadyActive: true }
  }

  getInviteLink(userId: string, gateway: IAccessGateway, botUsername: string): string {
    const user = gateway.getUser(userId)
    if (!user) return ""
    return `https://t.me/${botUsername}?start=${user.inviteCode}`
  }
}
