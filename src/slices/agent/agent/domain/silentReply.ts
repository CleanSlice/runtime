/**
 * Sentinel the model emits as its entire reply when it has nothing
 * to say (e.g. after a silent restart-recovery, when the goal was
 * already achieved). The runtime detects this exact token and skips
 * the outgoing message instead of forwarding it to the channel.
 *
 * Strict contract: the token must be the ONLY content of the reply.
 * Trailing/leading whitespace is tolerated; anything else is treated
 * as a real assistant message.
 */
export const SILENT_REPLY_TOKEN = "NO_REPLY"

/** True when the model's reply is exactly the sentinel (ignoring whitespace). */
export function isSilentReply(text: string | null | undefined): boolean {
  if (!text) return false
  return text.trim() === SILENT_REPLY_TOKEN
}

/**
 * True while a streaming accumulated text could still resolve to the
 * sentinel. Used to hold off chunk delivery in streaming channels so
 * the user never sees "N" / "NO_REP" before we realize it's NO_REPLY.
 *
 * Empty string returns false — there's nothing yet to suppress and an
 * empty chunk shouldn't gate the placeholder.
 */
export function isSilentReplyPrefix(text: string | null | undefined): boolean {
  if (!text) return false
  const trimmed = text.trim()
  if (trimmed.length === 0) return false
  return SILENT_REPLY_TOKEN.startsWith(trimmed)
}
