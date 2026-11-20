export interface ICommandContext {
  from: string
  channel: string
  sessionId: string
  text: string
  /**
   * The sender is an administrator, as the route decided it (CLEAN-236):
   * a configured admin id, or the hub's word for a console Admin whose id
   * no list here names. Absent → the access list is asked about `from`.
   */
  isAdmin?: boolean
}

export interface ICommandResult {
  handled: boolean
  /** Text already sent to user (or null if nothing to send) */
  response?: string
  /** If set, re-route message with this text instead (e.g. /memory → LLM passthrough) */
  passthrough?: string
}
