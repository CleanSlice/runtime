/**
 * Who a turn is acting for, as Ranch is told on every `tools/list` and
 * `tools/call` (CLEAN-232, ranch `specs/032-agent-user-access/contracts/
 * acting-party.md` §1). A person is proven by a token the API signed; the
 * `trusted` kinds are the agent speaking for itself and are bounded by its
 * own token; a guest has no management power.
 */
export type IActor =
  | { kind: "person"; token: string }
  | { kind: "trusted"; via: "internal" | "channel-admin" }
  | { kind: "guest" }

/** `_meta` key the actor travels under. */
export const ACTOR_META_KEY = "ranch/actor"

/** The chat identity every console Owner and Admin shares on the bridle hub. */
const CONSOLE_ADMIN_FROM = "admin"

/**
 * What the actor is read from: the channel message and runtime state, never
 * anything the model wrote. `ToolContext` and `ILoopContext` both fit.
 */
export interface IActorSource {
  /** The hub's acting token for this message (`Message.acting`). */
  acting?: { token: string }
  /** The turn is the agent's own: a cron job or a heartbeat. */
  isInternal?: boolean
  /** The sender is one of the agent's configured admin ids. */
  isAdmin?: boolean
  from?: string
  channel?: string
  /**
   * An actor resolved earlier for this turn. A delegated worker carries its
   * parent's, so it wins over everything else: a worker runs as an internal
   * task, and must not become `trusted` because of that.
   */
  actor?: IActor
}

/**
 * The actor of a turn, in the order of the contract's table:
 *
 * 1. a message that carried an acting token is that person;
 * 2. a turn the agent started for itself is `trusted` / `internal`;
 * 3. an admin the agent's own configuration names (`TELEGRAM_BOT_ADMIN_IDS`)
 *    is `trusted` / `channel-admin`;
 * 4. everyone else is a guest.
 *
 * The console is the exception to 3: its Owners and Admins share the from-id
 * "admin", which the runtime also counts as an admin id, but a console
 * message is only ever vouched for by a token. Without one it is a guest's,
 * and so is anything else that arrives over the bridle hub: the hub names a
 * person with a token or not at all. Why stricter than the contract's row:
 * `channel-admin` is the agent's full power at Ranch, and an admin id is a
 * bare string compared across channels, so a hub client id that happened to
 * equal one would otherwise be trusted on its word.
 */
export function actorOf(src: IActorSource): IActor {
  if (src.actor) return src.actor
  const token = src.acting?.token
  if (typeof token === "string" && token) return { kind: "person", token }
  if (src.isInternal === true) return { kind: "trusted", via: "internal" }
  if (src.isAdmin === true && src.from !== CONSOLE_ADMIN_FROM && src.channel !== "bridle") {
    return { kind: "trusted", via: "channel-admin" }
  }
  return { kind: "guest" }
}

/**
 * The actor of an inbound message, as the runtime starts its turn.
 *
 * `selfStarted` is the runtime's own statement that its cron or heartbeat
 * module emitted this turn (`turnFlags`, origin `self`). It is never read
 * off the message: `from` is an id a channel delivered, and a hub client
 * named "cron" or "heartbeat" was the agent itself for as long as the name
 * decided. Only such a turn is `trusted` / `internal`.
 *
 * A crash recovery is not one. It resumes somebody's conversation under
 * their own channel and from-id, carries no token, and the record it is
 * rebuilt from does not say who started it, so it is its sender's again:
 * a configured channel admin, else a guest. Why stricter than the
 * contract's row: `trusted` / `internal` is the agent's full power at
 * Ranch, and treating recovery as internal would hand it to whoever's turn
 * a crash interrupted, a share visitor included.
 *
 * `isConfiguredAdmin` is the access list's answer for the sender, not the
 * `isAdmin` a turn of the agent's own is given.
 */
export function actorOfMessage(
  msg: { acting?: { token: string }; from: string; channel: string },
  selfStarted: boolean,
  isConfiguredAdmin: boolean,
): IActor {
  return actorOf({
    acting: msg.acting,
    isInternal: selfStarted === true,
    isAdmin: isConfiguredAdmin,
    from: msg.from,
    channel: msg.channel,
  })
}

/** A label for logs and cache keys' readable half. Never contains the token. */
export function actorLabel(actor: IActor): string {
  if (actor.kind === "trusted") return `trusted:${actor.via}`
  return actor.kind
}
