export type RouteResult =
  | { action: "handled" }
  | { action: "passthrough"; text: string }
  | { action: "join"; taskId: string }
  | { action: "new-task" }
