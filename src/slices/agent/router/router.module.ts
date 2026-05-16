import type { LlmModule } from "../../setup/llm/llm.module"
import { RouterGateway } from "./data/router.gateway"
import { RouterService } from "./domain/router.service"

export { RouterService } from "./domain/router.service"
export type { IRouterGateway } from "./domain/router.gateway"
export type { IRouterTask, RouterDecision, IPendingDisambiguation } from "./domain/router.types"

export class RouterModule {
  readonly service: RouterService

  constructor(llm: LlmModule) {
    const gateway = new RouterGateway(llm)
    this.service = new RouterService(gateway)
  }
}
