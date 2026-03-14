import { AccessService } from "./domain/access.service"
import { AccessGateway } from "./data/access.gateway"
import type { IAccessStrategy, UserRecord } from "./domain/access.types"

export class AccessModule {
  private service: AccessService

  constructor(agentDir: string, adminIds: string[] = [], strategy: IAccessStrategy) {
    this.service = new AccessService(new AccessGateway(agentDir), strategy, adminIds)
  }

  isAdmin(userId: string): boolean {
    return this.service.isAdmin(userId)
  }

  isAllowed(userId: string): boolean {
    return this.service.isAllowed(userId)
  }

  processInvite(newUserId: string, code: string) {
    return this.service.processInvite(newUserId, code)
  }

  getInviteLink(userId: string, botUsername: string): string {
    return this.service.getInviteLink(userId, botUsername)
  }

  registerPending(userId: string): UserRecord {
    return this.service.registerPending(userId)
  }

  getUser(userId: string): UserRecord | undefined {
    return this.service.getUser(userId)
  }

  stats() {
    return this.service.stats()
  }
}
