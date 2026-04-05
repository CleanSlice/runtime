import { AccessService } from "./domain/access.service"
import { AccessGateway } from "./data/access.gateway"
import type { IAccessStrategy, UserRecord } from "./domain/access.types"
import { ApprovalRepository } from "./data/repositories/approval/approval.repository"
import { OpenRepository } from "./data/repositories/open/open.repository"
import { AllowlistRepository } from "./data/repositories/allowlist/allowlist.repository"
import { CodeRepository } from "./data/repositories/code/code.repository"

export class AccessModule {
  private service: AccessService

  constructor(agentDir: string, adminIds: string[] = [], strategy: IAccessStrategy) {
    this.service = new AccessService(new AccessGateway(agentDir), strategy, adminIds)
  }

  /** Factory: create AccessModule from config without importing concrete repositories */
  static create(agentDir: string, adminIds: string[], config: {
    accessStrategy?: "open" | "allowlist" | "code" | "approval"
    allowlist?: string[]
    accessCode?: string
  }): AccessModule {
    const strategy = config.accessStrategy ?? "approval"
    let impl: IAccessStrategy
    switch (strategy) {
      case "open":
        impl = new OpenRepository()
        break
      case "allowlist":
        impl = new AllowlistRepository(config.allowlist ?? [])
        break
      case "code":
        impl = new CodeRepository(config.accessCode ?? "")
        break
      case "approval":
      default:
        impl = new ApprovalRepository()
        break
    }
    return new AccessModule(agentDir, adminIds, impl)
  }

  isAdmin(userId: string): boolean {
    return this.service.isAdmin(userId)
  }

  isAllowed(userId: string): boolean {
    return this.service.isAllowed(userId)
  }

  registerPending(userId: string): UserRecord {
    return this.service.registerPending(userId)
  }

  getUser(userId: string): UserRecord | undefined {
    return this.service.getUser(userId)
  }

  approve(code: string): UserRecord | undefined {
    return this.service.approve(code)
  }

  stats() {
    return this.service.stats()
  }
}
