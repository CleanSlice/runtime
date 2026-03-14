export interface Message {
  id: string
  text: string
  from: string      // user id or channel id
  channel: string   // "telegram" | "slack" | "discord" | "api"
  ts: number        // unix timestamp ms
  sessionId: string
  metadata?: Record<string, unknown>
}

export interface Channel {
  name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(to: string, text: string): Promise<void>
  onMessage(handler: (msg: Message) => Promise<void>): void
}
