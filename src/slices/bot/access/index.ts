export { AccessModule } from "./access.module"
export type { UserRecord, UserStatus, AccessResult, IAccessStrategy } from "./domain/access.types"
export type { IAccessGateway } from "./domain/access.gateway"
export { AccessGateway } from "./data/access.gateway"

export { OpenRepository } from "./data/repositories/open/open.repository"
export { AllowlistRepository } from "./data/repositories/allowlist/allowlist.repository"
export { CodeRepository } from "./data/repositories/code/code.repository"
export { ApprovalRepository } from "./data/repositories/approval/approval.repository"
