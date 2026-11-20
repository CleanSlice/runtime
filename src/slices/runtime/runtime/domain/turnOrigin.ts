/**
 * Where a turn came from, as the runtime itself knows it (CLEAN-232).
 *
 * The answer is a fact of the call path, never of the message: `from` and
 * `channel` are strings a channel delivered, and on the bridle hub `from` is
 * a client id somebody outside chose (an embed token's `sub`). A turn used to
 * be internal, an admin's, and `trusted` / `internal` at Ranch, because its
 * `from` read "cron" or "heartbeat"; a visitor named that way got the agent's
 * full power, past the access gate. So the caller states the origin:
 *
 * - `channel`: a message a channel delivered. Never internal, never the
 *   agent's own, whatever it says about itself.
 * - `self`: the cron or the heartbeat module emitted it. The only origin a
 *   turn can be the agent's own from.
 * - `recovery`: a turn resumed after a crash. It runs with nobody waiting on
 *   the channel, so it is internal, but it is somebody's conversation under
 *   their channel and from-id, and the activity record it is rebuilt from
 *   does not say who started it. It is never the agent's own.
 */
export type TurnOriginTypes = "channel" | "self" | "recovery"

export interface ITurnFlags {
  /** Nobody is waiting on a channel: no typing, no streaming, no router. */
  isInternal: boolean
  /** The agent started this turn for itself: local admin, `trusted` at Ranch. */
  selfStarted: boolean
}

/**
 * Whether a turn is an administrator's, here in the runtime: the prompt's
 * admin-only blocks, the admin skills, the admin-only tools and commands
 * (CLEAN-236). It says nothing to Ranch, which is told the actor.
 *
 * - A turn the agent started for itself is.
 * - A sender the agent's own configuration names is: a Telegram admin id,
 *   and `admin` on the bridle hub, which is the Owner.
 * - A sender the hub says is an administrator is (`msg.admin`). Every Owner
 *   and Admin used to be `from: "admin"`; an Admin now has their own id,
 *   which no list here knows.
 * - Another agent's question never is, whatever else it carries.
 */
export function turnIsAdmin(
  msg: { admin?: boolean; handover?: { token: string } },
  senderIsConfiguredAdmin: boolean,
  selfStarted: boolean,
): boolean {
  if (msg.handover?.token) return false
  if (selfStarted === true) return true
  return msg.admin === true || senderIsConfiguredAdmin === true
}

/** A cron job addressed to nobody, or a heartbeat. */
function isBackgroundJob(msg: { from: string; channel: string }): boolean {
  return msg.channel === "internal" || msg.from === "cron" || msg.from === "heartbeat"
}

/**
 * The flags of a turn. A cron job addressed to a person on a channel
 * (`to` + `channel`) is that person's turn, routed and gated like their own
 * message, as before: only a job with no addressee is the agent's own.
 */
export function turnFlags(origin: TurnOriginTypes, msg: { from: string; channel: string }): ITurnFlags {
  if (origin === "self") {
    const own = isBackgroundJob(msg)
    return { isInternal: own, selfStarted: own }
  }
  if (origin === "recovery") return { isInternal: true, selfStarted: false }
  return { isInternal: false, selfStarted: false }
}
