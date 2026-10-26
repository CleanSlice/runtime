export { GuardModule, type IGuardModuleConfig } from "./guard.module"
export { GuardService, GuardLoadError, parseRule, redactDeep } from "./domain/guard.service"
export type { IGuardGateway } from "./domain/guard.gateway"
export type {
  IRule, IRuleMatch, IRuleFile, IGuardCall, IToolCallRecord, IBeforeVerdict, IAfterMeta, IAfterVerdict,
  IRuleFiringCount, CallOutcome, RuleAction, RuleEvent, RuleSource,
} from "./domain/guard.types"
