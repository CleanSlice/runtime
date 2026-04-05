import type { IActivity } from "./activity.types"

/** Gateway for persisting activity state (crash recovery) */
export interface IActivityGateway {
  set(activity: IActivity): void
  get(): IActivity | null
  updateStep(step: string): void
  clear(): void
}
