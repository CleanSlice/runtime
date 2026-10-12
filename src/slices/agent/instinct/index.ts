export { InstinctModule } from "./instinct.module"
export { InstinctService, instinctId } from "./domain/instinct.service"
export { buildInstinctReviewPrompt, parseInstinctReview } from "./domain/prompts/instinct-review.prompt"
export type { IInstinctGateway } from "./domain/instinct.gateway"
export type {
  IInstinct, IEvidence, IInstinctConfig, IInstinctSummary, InstinctBand, InstinctScope, InstinctSource, ReviewItem,
} from "./domain/instinct.types"
export { DEFAULT_INSTINCT_CONFIG } from "./domain/instinct.types"
