import type { Message } from "../../../shared/types/Message"

export interface Channel {
  name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(to: string, text: string): Promise<void>
  onMessage(handler: (msg: Message) => Promise<void>): void
}
