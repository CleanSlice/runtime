export interface ICommandContext {
  from: string
  channel: string
  sessionId: string
  text: string
}

export interface ICommandResult {
  handled: boolean
  /** Text already sent to user (or null if nothing to send) */
  response?: string
  /** If set, re-route message with this text instead (e.g. /memory → LLM passthrough) */
  passthrough?: string
}
