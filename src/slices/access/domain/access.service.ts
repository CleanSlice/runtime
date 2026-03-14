import type { IAccessGateway } from "./access.gateway"
import type { UserRecord } from "./access.types"

export class AccessService {
  constructor(private gateway: IAccessGateway) {}

  getUser(userId: string): UserRecord | undefined {
    return this.gateway.getUser(userId)
  }

  stats(): { total: number; active: number; pending: number } {
    const users = this.gateway.getAllUsers()
    return {
      total: users.length,
      active: users.filter(u => u.status === "active" || u.status === "admin").length,
      pending: users.filter(u => u.status === "pending").length,
    }
  }
}
