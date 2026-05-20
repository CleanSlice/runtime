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

// Markdown formatting characters the model sometimes wraps the sentinel in
// (e.g. `NO_REPLY`, **NO_REPLY**, ```NO_REPLY```). Stripped before comparison
// so the sentinel still suppresses the reply when formatted.
const MARKDOWN_WRAP_CHARS = new Set(["`", "*", "_", "~"])

function stripMarkdownWrap(text: string): string {
  let t = text.trim()
  while (t.length > 0 && MARKDOWN_WRAP_CHARS.has(t[0]!)) t = t.slice(1)
  while (t.length > 0 && MARKDOWN_WRAP_CHARS.has(t[t.length - 1]!)) t = t.slice(0, -1)
  return t.trim()
}

/** True when the model's reply is the sentinel, tolerating whitespace and markdown wrapping. */
export function isSilentReply(text: string | null | undefined): boolean {
  if (!text) return false
  return stripMarkdownWrap(text) === SILENT_REPLY_TOKEN
}

/**
 * True while a streaming accumulated text could still resolve to the
 * sentinel. Used to hold off chunk delivery in streaming channels so
 * the user never sees "N" / "NO_REP" before we realize it's NO_REPLY.
 *
 * Tolerates a leading markdown wrap char (` * _ ~) so a model that starts
 * with `\`` doesn't leak that backtick before the rest of the sentinel arrives.
 *
 * Empty string returns false — there's nothing yet to suppress and an
 * empty chunk shouldn't gate the placeholder.
 */
export function isSilentReplyPrefix(text: string | null | undefined): boolean {
  if (!text) return false
  let trimmed = text.trim()
  if (trimmed.length === 0) return false
  while (trimmed.length > 0 && MARKDOWN_WRAP_CHARS.has(trimmed[0]!)) {
    trimmed = trimmed.slice(1)
  }
  if (trimmed.length === 0) return true
  return SILENT_REPLY_TOKEN.startsWith(trimmed)
}
