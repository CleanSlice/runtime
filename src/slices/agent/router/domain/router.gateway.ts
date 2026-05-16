import type { IRouterTask, RouterDecision } from "./router.types"

export interface IRouterGateway {
  route(sessionId: string, text: string, runningTasks: IRouterTask[]): Promise<RouterDecision>
  clear(sessionId: string): void
}
