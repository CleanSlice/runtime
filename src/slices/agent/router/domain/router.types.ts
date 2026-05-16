export interface IRouterTask {
  id: string
  label: string
}

export interface IPendingDisambiguation {
  question: string
  options: IRouterTask[]
  askedAt: number
}

export type RouterDecision =
  | { kind: "new" }
  | { kind: "join"; taskId: string }
  | { kind: "ask"; question: string }
