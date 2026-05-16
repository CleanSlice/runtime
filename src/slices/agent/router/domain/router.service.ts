import type { IRouterGateway } from "./router.gateway"
import type { IRouterTask, RouterDecision } from "./router.types"

export class RouterService {
  constructor(private gateway: IRouterGateway) {}

  /** Classify an incoming user message into new / join / ask. Used by BotService. */
  route(sessionId: string, text: string, runningTasks: IRouterTask[]): Promise<RouterDecision> {
    return this.gateway.route(sessionId, text, runningTasks)
  }

  /** Drop any pending disambiguation for a session (e.g. on /cancel or stop). */
  clear(sessionId: string): void {
    this.gateway.clear(sessionId)
  }
}
