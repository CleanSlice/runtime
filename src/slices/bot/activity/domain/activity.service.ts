import type { IActivityGateway } from "./activity.gateway"
import type { IActivity } from "./activity.types"

/** Domain service for activity tracking */
export class ActivityService {
  constructor(private gateway: IActivityGateway) {}

  set(activity: IActivity): void {
    this.gateway.set(activity)
  }

  get(): IActivity | null {
    return this.gateway.get()
  }

  updateStep(step: string): void {
    this.gateway.updateStep(step)
  }

  clear(): void {
    this.gateway.clear()
  }
}
