import type { IChannelGateway } from "./channel.gateway"

// ── Enums ─────────────────────────────────────────────────────

export enum MessagePartTypes {
  Text = "text",
  Image = "image",
  File = "file",
  Ui = "ui",
  UiSubmit = "ui_submit",
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

// ── Interactive UI parts (Bridle ≥ v0.12.0) ───────────────────
// Agent → client: render an interactive form in the bubble.
// Client → agent: ship the submitted values back, scoped by uiId.
// Channels that don't render UI (Telegram, etc.) just pass these through
// unchanged — the agent should capability-gate before emitting them.

export type MessageUiOption = { value: string; label: string }

export type MessageUiComponent =
  | { type: "heading"; text: string }
  | { type: "text"; text: string }
  | {
      type: "input"
      name: string
      label?: string
      placeholder?: string
      required?: boolean
      default?: string
    }
  | {
      type: "textarea"
      name: string
      label?: string
      placeholder?: string
      required?: boolean
      default?: string
    }
  | {
      type: "radio"
      name: string
      label?: string
      required?: boolean
      default?: string
      options: MessageUiOption[]
    }
  | { type: "checkbox"; name: string; label: string; default?: boolean }
  | {
      type: "checkbox-group"
      name: string
      label?: string
      required?: boolean
      default?: string[]
      options: MessageUiOption[]
    }
  | {
      type: "select"
      name: string
      label?: string
      placeholder?: string
      required?: boolean
      default?: string
      options: MessageUiOption[]
    }

export interface IMessageUiPart {
  type: MessagePartTypes.Ui
  uiId: string
  components: MessageUiComponent[]
  submit?: { label?: string }
}

export type MessageUiValue = string | boolean | string[]

export interface IMessageUiSubmitPart {
  type: MessagePartTypes.UiSubmit
  uiId: string
  values: Record<string, MessageUiValue>
}

export type MessagePart =
  | IMessageTextPart
  | IMessageImagePart
  | IMessageFilePart
  | IMessageUiPart
  | IMessageUiSubmitPart

// ── Thinking (live reasoning steps) ───────────────────────────

/**
 * One published unit of agent work inside a live thinking timeline —
 * channel-agnostic shape emitted via `IChannelGateway.sendThinking`.
 * `active` before the work starts, `done` (same `id`) when it finishes.
 * Labels/detail are shown to end users: humanized names and reasoning
 * prose only, never raw tool params or prompts.
 */
export interface IThinkingStep {
  id: string
  label: string
  detail?: string
  state: "active" | "done"
}

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
  /**
   * What part types the originating client can render. Set by channels that
   * advertise it (Bridle SDK ≥ v0.12.0 sends `["streaming","images","files","ui"]`
   * on handshake; the hub forwards it on every message). Older clients and
   * channels without the concept (Telegram, email) leave this undefined —
   * agents should default to text when checking.
   *
   * Known values: `"streaming"`, `"images"`, `"files"`, `"ui"`, `"thinking"`.
   */
  capabilities?: string[]
  /**
   * Integrator-supplied context attached to the embed (`data-prompt` on the
   * Bridle `<script>` tag). The hub forwards it on every message in the
   * session. Fold it into the system prompt so the agent gets page/user/
   * tenant context without code changes. Treat as untrusted — it originates
   * in the visitor's browser. Channels without the concept leave it undefined.
   */
  prompt?: string
}

// ── Helpers ───────────────────────────────────────────────────

export function getMessageImages(msg: Message): IMessageImagePart[] {
  return msg.parts.filter((p): p is IMessageImagePart => p.type === MessagePartTypes.Image)
}

export function getMessageFiles(msg: Message): IMessageFilePart[] {
  return msg.parts.filter((p): p is IMessageFilePart => p.type === MessagePartTypes.File)
}

export function getMessageUiParts(msg: Message): IMessageUiPart[] {
  return msg.parts.filter((p): p is IMessageUiPart => p.type === MessagePartTypes.Ui)
}

export function getMessageUiSubmits(msg: Message): IMessageUiSubmitPart[] {
  return msg.parts.filter((p): p is IMessageUiSubmitPart => p.type === MessagePartTypes.UiSubmit)
}

export function buildMessage(fields: {
  id: string
  text: string
  from: string
  channel: string
  ts: number
  role?: MessageRoleTypes
  /**
   * Pre-assembled parts (used by channels that decode the wire-format
   * themselves — e.g. bridle delivering `ui` / `ui_submit`). When set,
   * takes precedence over `text` / `images` / `files`. When unset, the
   * legacy text+images+files path is used so callers don't break.
   */
  parts?: MessagePart[]
  images?: Array<{ base64: string; mediaType: string }>
  files?: Array<{ path: string; name: string; mimeType?: string }>
  capabilities?: string[]
  /** Integrator context from the embed's `data-prompt` (see Message.prompt). */
  prompt?: string
  metadata?: Record<string, unknown>
}): Message {
  let parts: MessagePart[]
  if (fields.parts) {
    parts = fields.parts
  } else {
    parts = []
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
  }
  return {
    id: fields.id,
    role: fields.role ?? MessageRoleTypes.User,
    text: fields.text,
    parts,
    from: fields.from,
    channel: fields.channel,
    ts: fields.ts,
    ...(fields.capabilities?.length ? { capabilities: fields.capabilities } : {}),
    ...(fields.prompt ? { prompt: fields.prompt } : {}),
    metadata: fields.metadata,
  }
}

/**
 * Build a `ui` MessagePart the SDK can render as an interactive form.
 * Auto-generates `uiId` when omitted so agents don't have to roll one
 * themselves — but pass a stable string for multi-step flows where you
 * need to match the submit back to the question.
 *
 * @example
 *   await bridle.send(msg.from, "Pick a plan", [
 *     { type: MessagePartTypes.Text, text: "Pick a plan" },
 *     buildUiForm([
 *       { type: "radio", name: "plan", required: true, options: [
 *         { value: "basic", label: "Basic" },
 *         { value: "pro",   label: "Pro" },
 *       ]},
 *     ], { uiId: "plan-pick", submitLabel: "Continue" }),
 *   ])
 */
export function buildUiForm(
  components: MessageUiComponent[],
  opts: { uiId?: string; submitLabel?: string } = {},
): IMessageUiPart {
  // Native crypto.randomUUID exists on Node ≥ 14.17 and all current browsers.
  // Avoid importing node:crypto so this stays bundle-friendly.
  const uiId =
    opts.uiId ??
    (typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `ui-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`)
  return {
    type: MessagePartTypes.Ui,
    uiId,
    components,
    ...(opts.submitLabel ? { submit: { label: opts.submitLabel } } : {}),
  }
}

// ── Groups ────────────────────────────────────────────────────
// Channel-agnostic view of a group/room/channel the bot works in. Each
// channel maps its own concept onto this shape: Telegram groups/supergroups
// (from the persisted registry), Slack channels (live API query). Channels
// without the concept (bridle) report none.

export interface IChannelGroup {
  id: string          // conversation id usable for sending (telegram chat_id, slack channel id)
  name?: string       // group title / channel name
  username?: string   // public handle when the platform has one (telegram @username)
  type?: string       // platform-specific: "supergroup" | "channel" | "public_channel" | ...
  status?: string     // bot's membership when the platform reports it (telegram: member | left | ...)
  lastSeenAt?: number // unix ms of last observed activity, when tracked
}

// ── Channel Config ────────────────────────────────────────────

export type ChannelConfig =
  | { type: "telegram"; token: string }
  | { type: "slack"; botToken: string; appToken: string }
  | { type: "bridle"; apiUrl: string }
  | { type: "mock"; instance: IChannelGateway }
