/**
 * How much of a user message survives into the model call.
 *
 * The attachment cap is separate and much larger on purpose. Ranch's API
 * already inlines a *bounded* spreadsheet preview — 40 000 characters, cut at
 * row boundaries, with per-sheet omission counts and a pointer to the
 * `query_attachment` tool for the rest. Folding that preview into the
 * ordinary long-message cap left 2 500 characters of it, so the model met a
 * fragment of sheet one and guessed the remainder instead of reading the
 * file (CLEAN-82).
 *
 * The ordinary cap stays where it was: it exists to stop a pasted wall of
 * repetitive text from slowing every later turn, and that reasoning is
 * untouched by attachments.
 */
export interface IMessageLimits {
  /** Cap on an ordinary user message. */
  maxChars: number
  /** Cap on a user message that carries an attachment. */
  maxCharsWithAttachments: number
}

/** Characters kept from the end of an over-long message. */
const TAIL_CHARS = 500

/** The cap that applies to one user event. */
export function limitForUserEvent(
  hasAttachments: boolean,
  limits: IMessageLimits,
): number {
  return hasAttachments ? limits.maxCharsWithAttachments : limits.maxChars
}

/**
 * Head + tail of an over-long message with an honest count of the gap.
 *
 * The count is what was actually removed. The previous inline version
 * reported `length - limit + TAIL_CHARS`, which understated the gap by
 * `limit / 2 - TAIL_CHARS` characters — 1 000 at the default cap.
 */
export function truncateUserText(text: string, limit: number): string {
  if (limit <= 0 || text.length <= limit) return text

  const head = Math.floor(limit / 2)
  const tail = Math.min(TAIL_CHARS, limit - head)
  const kept = head + tail
  if (kept >= text.length) return text

  const removed = text.length - kept
  return (
    `${text.slice(0, head)}\n\n` +
    `[… ${removed} characters truncated — message was very long/repetitive …]\n\n` +
    `${text.slice(text.length - tail)}`
  )
}
