/**
 * Who is at the door (CLEAN-236). `BotService.route` used to ask the access
 * list about `msg.from` three times: to approve an access code, to run a
 * slash command, to let the message in. Two things the id cannot say made
 * that wrong:
 *
 * - an Admin of the console has a conversation of their own now, under
 *   their own id, which no list here names. The hub says they are an
 *   administrator; without that they were asked for an access code.
 * - another agent's question arrives under an id of its own
 *   (`peer:<connection>:<context>`). It is not a visitor to be let in or
 *   kept out: Ranch already decided the connection may be used. As a
 *   visitor it was registered as pending and sent an access code, which
 *   went back to the asking agent as the answer.
 *
 * So who it is is decided once, from the message, and the rest of the
 * route reads the result.
 */
export const GateTypes = {
  /** Another agent's question: no approval, no commands, no access check. */
  Colleague: "colleague",
  /** An administrator: approves access codes, runs every command, is let in. */
  Admin: "admin",
  /** Anybody else: the only one the access strategy is asked about. */
  Visitor: "visitor",
} as const
export type GateTypes = (typeof GateTypes)[keyof typeof GateTypes]

/**
 * `isAdmin` is `turnIsAdmin` for the message: a configured admin id, or the
 * hub's word. A hand-over wins over it: a colleague's question is never an
 * administrator's, whatever else the message says of itself. An
 * administrator is let in without asking the strategy, as a configured
 * admin id always was (every strategy lets those through).
 */
export function gateFor(
  msg: { handover?: { token: string } },
  isAdmin: boolean,
): GateTypes {
  if (msg.handover?.token) return GateTypes.Colleague
  return isAdmin === true ? GateTypes.Admin : GateTypes.Visitor
}
