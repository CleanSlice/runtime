export type EventType = "user" | "assistant" | "tool_call" | "tool_result" | "system"

export interface Event {
  id: string
  type: EventType
  ts: number
  data: unknown
}
