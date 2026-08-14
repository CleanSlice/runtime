import type { IChannelGroup, Message, MessagePart } from "./channel.types"

export interface IChannelGateway {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(to: string, text: string, parts?: MessagePart[]): Promise<void>
  onMessage(handler: (msg: Message) => Promise<void>): void
  /**
   * Stream text to the channel — sends a placeholder, then edits it as chunks arrive.
   * onStream is called with a function that accepts accumulated text.
   * Returns when streaming is complete.
   */
  streamSend?(to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<void>
  /**
   * Ephemeral "agent is working" signal for the channel's UI. Optional —
   * only channels with a live typing affordance (bridle) implement it.
   * Best-effort: implementations must never throw on a dead connection.
   */
  sendTyping?(to: string): Promise<void>
  /**
   * Groups/rooms/channels the bot works in, in a channel-agnostic shape.
   * Optional — channels without the concept (bridle) don't implement it.
   * Telegram serves its persisted registry; Slack queries the API live.
   */
  listGroups?(): Promise<IChannelGroup[]>
}
