import { AccessService } from "./domain/access.service"
import { AccessGateway } from "./data/access.gateway"
import type { IAccessStrategy, StrategyName, StrategyOverride, UserRecord } from "./domain/access.types"
import { ApprovalRepository } from "./data/repositories/approval/approval.repository"
import { OpenRepository } from "./data/repositories/open/open.repository"
import { PublicRepository } from "./data/repositories/public/public.repository"
import { AllowlistRepository } from "./data/repositories/allowlist/allowlist.repository"
import { CodeRepository } from "./data/repositories/code/code.repository"

export interface IStrategyConfig {
  accessStrategy?: StrategyName
  allowlist?: string[]
  accessCode?: string
}

export class AccessModule {
  private gateway: AccessGateway
  private service: AccessService

  constructor(agentDir: string, adminIds: string[] = [], strategy: IAccessStrategy) {
    this.gateway = new AccessGateway(agentDir)
    this.service = new AccessService(this.gateway, strategy, adminIds)
  }

  /** Factory: create AccessModule from config. Persisted runtime override (if any) takes precedence. */
  static create(agentDir: string, adminIds: string[], config: IStrategyConfig): AccessModule {
    const probe = new AccessGateway(agentDir)
    const override = probe.getStrategyOverride()
    const effective: IStrategyConfig = override
      ? { accessStrategy: override.name, allowlist: override.allowlist, accessCode: override.accessCode }
      : config
    return new AccessModule(agentDir, adminIds, AccessModule.buildStrategy(effective))
  }

  private static buildStrategy(config: IStrategyConfig): IAccessStrategy {
    const name: StrategyName = config.accessStrategy ?? "approval"
    switch (name) {
      case "open":
        return new OpenRepository()
      case "public":
        return new PublicRepository()
      case "allowlist":
        return new AllowlistRepository(config.allowlist ?? [])
      case "code":
        return new CodeRepository(config.accessCode ?? "")
      case "approval":
      default:
        return new ApprovalRepository()
    }
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

  getStrategyName(): string {
    return this.service.getStrategyName()
  }

  /** Switch the active strategy at runtime. Persisted to data/access.json. */
  setStrategy(name: StrategyName, options?: { allowlist?: string[]; accessCode?: string }): void {
    const override: StrategyOverride = { name, allowlist: options?.allowlist, accessCode: options?.accessCode }
    const impl = AccessModule.buildStrategy({
      accessStrategy: name,
      allowlist: options?.allowlist,
      accessCode: options?.accessCode,
    })
    this.service.setStrategy(impl, override)
  }
}
