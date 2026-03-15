import type { Message } from "./channel.types"

export interface IChannelGateway {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(to: string, text: string): Promise<void>
  onMessage(handler: (msg: Message) => Promise<void>): void
  /**
   * Stream text to the channel — sends a placeholder, then edits it as chunks arrive.
   * onStream is called with a function that accepts accumulated text.
   * Returns when streaming is complete.
   */
  streamSend?(to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void>
}
