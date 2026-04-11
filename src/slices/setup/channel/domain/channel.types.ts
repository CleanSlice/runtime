import type { IChannelGateway } from "./channel.gateway"

// ── Enums ─────────────────────────────────────────────────────

export enum MessagePartTypes {
  Text = "text",
  Image = "image",
  File = "file",
}

export enum MessageRoleTypes {
  User = "user",
  Assistant = "assistant",
  System = "system",
}

// ── Parts ─────────────────────────────────────────────────────

export interface IMessageTextPart {
  type: MessagePartTypes.Text
  text: string
}

export interface IMessageImagePart {
  type: MessagePartTypes.Image
  base64: string
  mediaType: string  // "image/jpeg" | "image/png" | "image/webp" | "image/gif"
}

export interface IMessageFilePart {
  type: MessagePartTypes.File
  path: string
  name: string
  mimeType?: string
}

export type MessagePart = IMessageTextPart | IMessageImagePart | IMessageFilePart

// ── Message ───────────────────────────────────────────────────

export interface Message {
  id: string
  role: MessageRoleTypes
  text: string                        // plain-text shorthand (always populated)
  parts: MessagePart[]                // rich content (source of truth)
  from: string                        // user id or channel id
  channel: string                     // "telegram" | "slack" | "web" | "internal"
  ts: number                          // unix timestamp ms
  metadata?: Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────

export function getMessageImages(msg: Message): IMessageImagePart[] {
  return msg.parts.filter((p): p is IMessageImagePart => p.type === MessagePartTypes.Image)
}

export function getMessageFiles(msg: Message): IMessageFilePart[] {
  return msg.parts.filter((p): p is IMessageFilePart => p.type === MessagePartTypes.File)
}

export function buildMessage(fields: {
  id: string
  text: string
  from: string
  channel: string
  ts: number
  role?: MessageRoleTypes
  images?: Array<{ base64: string; mediaType: string }>
  files?: Array<{ path: string; name: string; mimeType?: string }>
  metadata?: Record<string, unknown>
}): Message {
  const parts: MessagePart[] = []
  if (fields.text) {
    parts.push({ type: MessagePartTypes.Text, text: fields.text })
  }
  if (fields.images) {
    for (const img of fields.images) {
      parts.push({ type: MessagePartTypes.Image, base64: img.base64, mediaType: img.mediaType })
    }
  }
  if (fields.files) {
    for (const file of fields.files) {
      parts.push({ type: MessagePartTypes.File, path: file.path, name: file.name, mimeType: file.mimeType })
    }
  }
  return {
    id: fields.id,
    role: fields.role ?? MessageRoleTypes.User,
    text: fields.text,
    parts,
    from: fields.from,
    channel: fields.channel,
    ts: fields.ts,
    metadata: fields.metadata,
  }
}

// ── Channel Config ────────────────────────────────────────────

export type ChannelConfig =
  | { type: "telegram"; token: string }
  | { type: "slack"; botToken: string; appToken: string }
  | { type: "bridle"; apiUrl: string }
  | { type: "mock"; instance: IChannelGateway }
