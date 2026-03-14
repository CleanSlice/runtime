import type { Message } from "./channel.types"

export interface IChannelGateway {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(to: string, text: string): Promise<void>
  onMessage(handler: (msg: Message) => Promise<void>): void
}
