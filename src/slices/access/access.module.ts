/**
 * Viral invite-based access control.
 *
 * Flow:
 * 1. New user sends /start → status = "pending", gets invite link
 * 2. Someone clicks their invite link → inviter is activated
 * 3. New user (the one who clicked) is now "pending" and needs to invite someone
 *
 * Admin users bypass all checks.
 */

import { mkdirSync } from "fs"
import { randomUUID } from "crypto"

export type UserStatus = "active" | "pending" | "admin"

export interface UserRecord {
  userId: string
  status: UserStatus
  inviteCode: string       // their personal invite code
  invitedBy?: string       // who invited them
  activatedAt?: number
  createdAt: number
}

export interface AccessStore {
  users: Record<string, UserRecord>
}

export class AccessModule {
  private storePath: string
  private store: AccessStore = { users: {} }
  private adminIds: string[]

  constructor(agentDir: string, adminIds: string[] = []) {
    this.storePath = `${agentDir}/data/access.json`
    this.adminIds = adminIds
    mkdirSync(`${agentDir}/data`, { recursive: true })
    this.load()

    // Ensure admins are always active
    for (const id of adminIds) {
      if (!this.store.users[id]) {
        this.store.users[id] = {
          userId: id,
          status: "admin",
          inviteCode: randomUUID().slice(0, 8),
          createdAt: Date.now(),
        }
        this.save()
      }
    }
  }

  private load(): void {
    try {
      const text = require("fs").readFileSync(this.storePath, "utf-8")
      this.store = JSON.parse(text)
    } catch {
      this.store = { users: {} }
    }
  }

  private save(): void {
    require("fs").writeFileSync(this.storePath, JSON.stringify(this.store, null, 2))
  }

  isAdmin(userId: string): boolean {
    return this.adminIds.includes(userId)
  }

  isAllowed(userId: string): boolean {
    const user = this.store.users[userId]
    return !!user && (user.status === "active" || user.status === "admin")
  }

  getUser(userId: string): UserRecord | undefined {
    return this.store.users[userId]
  }

  /** Register new user as pending. Returns their invite link info. */
  registerPending(userId: string): UserRecord {
    if (this.store.users[userId]) return this.store.users[userId]
    const record: UserRecord = {
      userId,
      status: "pending",
      inviteCode: randomUUID().slice(0, 8),
      createdAt: Date.now(),
    }
    this.store.users[userId] = record
    this.save()
    return record
  }

  /** Process invite code — activate the inviter, register the new user as pending */
  processInvite(newUserId: string, inviteCode: string): {
    activated?: UserRecord  // the person who gets activated
    newUser: UserRecord     // the new user (pending)
    alreadyActive?: boolean
  } {
    // Find who owns this invite code
    const inviter = Object.values(this.store.users).find(u => u.inviteCode === inviteCode)

    // Register new user as pending (with invitedBy)
    let newUser = this.store.users[newUserId]
    if (!newUser) {
      newUser = {
        userId: newUserId,
        status: "pending",
        inviteCode: randomUUID().slice(0, 8),
        invitedBy: inviter?.userId,
        createdAt: Date.now(),
      }
      this.store.users[newUserId] = newUser
    }

    if (!inviter) {
      this.save()
      return { newUser }
    }

    // Activate the inviter if they were pending
    if (inviter.status === "pending") {
      inviter.status = "active"
      inviter.activatedAt = Date.now()
      this.save()
      return { activated: inviter, newUser }
    }

    // Inviter already active
    this.save()
    return { activated: inviter, newUser, alreadyActive: true }
  }

  getInviteLink(userId: string, botUsername: string): string {
    const user = this.store.users[userId]
    if (!user) return ""
    return `https://t.me/${botUsername}?start=${user.inviteCode}`
  }

  stats(): { total: number; active: number; pending: number } {
    const users = Object.values(this.store.users)
    return {
      total: users.length,
      active: users.filter(u => u.status === "active" || u.status === "admin").length,
      pending: users.filter(u => u.status === "pending").length,
    }
  }
}
