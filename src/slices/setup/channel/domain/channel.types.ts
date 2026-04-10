import type { IChannelGateway } from "./channel.gateway"

export interface MessageImage {
  base64: string
  mediaType: string  // "image/jpeg" | "image/png" | "image/webp" | "image/gif"
}

export interface Message {
  id: string
  text: string
  from: string      // user id or channel id
  channel: string   // "telegram" | "slack" | "discord" | "api"
  ts: number        // unix timestamp ms
  sessionId: string
  images?: MessageImage[]
  metadata?: Record<string, unknown>
}

export interface Channel {
  name: string
  start(): Promise<void>
  stop(): Promise<void>
  send(to: string, text: string): Promise<void>
  onMessage(handler: (msg: Message) => Promise<void>): void
}

export type ChannelConfig =
  | { type: "telegram"; token: string }
  | { type: "slack"; botToken: string; appToken: string }
  | { type: "web"; apiUrl: string }
  | { type: "mock"; instance: IChannelGateway }
