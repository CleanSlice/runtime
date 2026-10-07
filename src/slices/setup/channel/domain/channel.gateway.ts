import type { IChannelGroup, IThinkingStep, Message, MessagePart } from "./channel.types"
import type { ISource } from "../../../runtime/loop/domain/loop.types"

export interface IChannelGateway {
  readonly name: string
  start(): Promise<void>
  stop(): Promise<void>
  /**
   * Resolves to the wire message id when the channel mints one (bridle), so
   * a follow-up event about that message — its `sources` — can name it.
   * Channels without message ids resolve to nothing.
   */
  send(to: string, text: string, parts?: MessagePart[]): Promise<string | void>
  onMessage(handler: (msg: Message) => Promise<void>): void
  /**
   * Stream text to the channel — sends a placeholder, then edits it as chunks arrive.
   * onStream is called with a function that accepts accumulated text.
   * Returns when streaming is complete.
   */
  streamSend?(to: string, streamer: (onChunk: (text: string) => void) => Promise<string>): Promise<string | void>
  /**
   * Ephemeral "agent is working" signal for the channel's UI. Optional —
   * only channels with a live typing affordance (bridle) implement it.
   * Best-effort: implementations must never throw on a dead connection.
   */
  sendTyping?(to: string): Promise<void>
  /**
   * Publish a live thinking-timeline update: a step, or (with `step`
   * omitted) the terminal turn-completion signal. Optional — only channels
   * whose UI renders thinking (bridle) implement it. Best-effort.
   */
  sendThinking?(to: string, turnId: string, step?: IThinkingStep): Promise<void>
  /**
   * Publish one bubble's validated citations (CLEAN-138): the corrected text
   * and the sources it cites, in citation order. Optional — only channels
   * whose UI can draw a source list (bridle) implement it. Best-effort.
   */
  sendSources?(to: string, messageId: string, text: string, sources: ISource[]): Promise<void>
  /**
   * Groups/rooms/channels the bot works in, in a channel-agnostic shape.
   * Optional — channels without the concept (bridle) don't implement it.
   * Telegram serves its persisted registry; Slack queries the API live.
   */
  listGroups?(): Promise<IChannelGroup[]>
}
