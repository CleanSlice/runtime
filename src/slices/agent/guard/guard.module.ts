import { GuardGateway } from "./data/guard.gateway"
import { GuardService } from "./domain/guard.service"
import type { IAfterMeta, IAfterVerdict, IBeforeVerdict, IGuardCall, IRule, IRuleFiringCount } from "./domain/guard.types"

export interface IGuardModuleConfig {
  observerTimeoutMs: number
  recordFile: string
  recordMaxBytes: number
  /** Test seam: where the baseline rules are read from. */
  baselineDir?: string
}

/** Guardrails around tool calls (CLEAN-150 US1): rule files in, verdicts and records out. */
export class GuardModule {
  private service: GuardService

  constructor(agentDir: string, cfg: IGuardModuleConfig) {
    const gateway = new GuardGateway(agentDir, { recordFile: cfg.recordFile, recordMaxBytes: cfg.recordMaxBytes, baselineDir: cfg.baselineDir })
    this.service = new GuardService(gateway, { observerTimeoutMs: cfg.observerTimeoutMs })
  }

  /** Load (or reload) every rule file. Throws `GuardLoadError`; the previous set stays active on failure. */
  load(): Promise<void> {
    return this.service.load()
  }

  markFailed(message: string): void {
    this.service.markFailed(message)
  }

  get isLoaded(): boolean {
    return this.service.isLoaded
  }

  get lastLoadError(): string | undefined {
    return this.service.lastLoadError
  }

  before(call: IGuardCall): IBeforeVerdict {
    return this.service.before(call)
  }

  after(call: IGuardCall, result: unknown, meta: IAfterMeta): Promise<IAfterVerdict> {
    return this.service.after(call, result, meta)
  }

  redactOutgoing(text: string): string {
    return this.service.redactOutgoing(text)
  }

  redactStreaming(accumulated: string): string {
    return this.service.redactStreaming(accumulated)
  }

  listRules(): IRule[] {
    return this.service.listRules()
  }

  recentFirings(hours: number): IRuleFiringCount[] {
    return this.service.recentFirings(hours)
  }

  observerFailures(): Record<string, number> {
    return this.service.observerFailures()
  }
}
