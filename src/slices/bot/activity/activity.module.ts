import { ActivityService } from "./domain/activity.service"
import { RecoveryService } from "./domain/recovery.service"
import { ActivityGateway } from "./data/activity.gateway"
import type { IActivityGateway } from "./domain/activity.gateway"

export class ActivityModule {
  readonly service: ActivityService
  readonly recovery: RecoveryService

  constructor(agentDir: string) {
    const gateway: IActivityGateway = new ActivityGateway(agentDir)
    this.service = new ActivityService(gateway)
    this.recovery = new RecoveryService(gateway)
  }
}
