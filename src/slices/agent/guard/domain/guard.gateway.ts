import type { IRuleFile, IToolCallRecord } from "./guard.types"

export interface IGuardGateway {
  /** Every rule file: the bundled baseline first, then the agent's own. Parse errors ride on `error`. */
  loadRuleFiles(): IRuleFile[]
  /** Append one tool-call record. Observers are bounded and fail-open; this may throw. */
  appendRecord(record: IToolCallRecord): Promise<void>
}
