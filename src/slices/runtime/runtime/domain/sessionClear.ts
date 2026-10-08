/** What forgetting a conversation needs from the runtime — structural, so a spec can stand in for each. */
export interface ISessionClearDeps {
  tasks: { cancelAll(sessionId: string): number }
  router: { clear(sessionId: string): void }
  session: { clear(channelId: string, userId: string): void }
}

/**
 * The bridle hub says a conversation was reset ("New chat", CLEAN-136): its
 * transcript was archived or deleted and every browser has emptied its view.
 *
 * Whatever is still running for that conversation is cancelled FIRST. A turn
 * left running would answer into the new conversation — the person asks
 * something, starts over, and the answer to the old question arrives as the
 * first message of the new chat — and would write its events back into the
 * session file this is about to remove. The hub refuses a reset while it can
 * see a turn open; this covers the turn it cannot see, one that went silent
 * for longer than the hub waits and then speaks.
 *
 * The same two calls the stop command makes, then the clear. Returns how many
 * tasks were cancelled.
 */
export function clearBridleSession(deps: ISessionClearDeps, channel: string): number {
  const sessionId = `bridle:${channel}`
  const cancelled = deps.tasks.cancelAll(sessionId)
  deps.router.clear(sessionId)
  deps.session.clear("bridle", channel)
  return cancelled
}
