import { InstinctGateway } from "./data/instinct.gateway"
import { InstinctService } from "./domain/instinct.service"
import type { IEvidence, IInstinct, IInstinctConfig, IInstinctSummary, InstinctBand, ReviewItem } from "./domain/instinct.types"
import { DEFAULT_INSTINCT_CONFIG } from "./domain/instinct.types"

/** Learned behaviours with confidence (CLEAN-150 US3). */
export class InstinctModule {
  private service: InstinctService
  readonly enabled: boolean

  constructor(agentDir: string, cfg: IInstinctConfig = DEFAULT_INSTINCT_CONFIG) {
    this.service = new InstinctService(new InstinctGateway(agentDir), cfg)
    this.enabled = cfg.enabled
  }

  load(): void {
    this.service.load()
  }

  list(): IInstinct[] {
    return this.service.list()
  }

  get(id: string): IInstinct | undefined {
    return this.service.get(id)
  }

  bandOf(confidence: number): InstinctBand {
    return this.service.bandOf(confidence)
  }

  render(): string {
    return this.enabled ? this.service.render() : ""
  }

  renderedIds(): string[] {
    return this.enabled ? this.service.renderedIds() : []
  }

  applyReview(items: ReviewItem[]): ReturnType<InstinctService["applyReview"]> {
    return this.service.applyReview(items)
  }

  reinforce(id: string, evidence?: IEvidence): IInstinct | undefined {
    return this.service.reinforce(id, evidence)
  }

  correct(id: string, evidence?: IEvidence): IInstinct | undefined {
    return this.service.correct(id, evidence)
  }

  decayIfDue(): boolean {
    return this.service.decayIfDue()
  }

  pin(id: string): void {
    this.service.pin(id)
  }

  unpin(id: string): void {
    this.service.unpin(id)
  }

  prune(id?: string): string[] {
    return this.service.prune(id)
  }

  promote(ids: string[], slug: string): { name: string; path: string } {
    return this.service.promote(ids, slug)
  }

  conflicts(): ReturnType<InstinctService["conflicts"]> {
    return this.service.conflicts()
  }

  summary(): IInstinctSummary {
    return this.service.summary()
  }
}
