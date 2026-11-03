import type { MemoryLimits } from "./memory.types"
import { MEMORY_FILE_LIMITS } from "./memory.types"

/**
 * Fitting a curated file (SOUL.md, USER.md, MEMORY.md, HEARTBEAT.md) into its
 * `memory.limits` budget — in memory only (CLEAN-207).
 *
 * The file on disk is never changed by anything here. The 0.33.0 runtime cut
 * SOUL.md on disk at boot; the dev Mazda agent's SOUL.md came to start with the
 * truncation marker, with its title, intro and audience section gone for good.
 * Now the operator's text stays whole, the prompt gets a copy that fits, and
 * the copy says how much was left out so the agent can tell anyone who asks.
 */

/**
 * Truncate `content` to `limit` characters by dropping whole lines from the
 * TOP (oldest content) until the remainder fits. A marker line is prepended so
 * the agent can see truncation happened. Returns `content` unchanged when it
 * already fits. A single oversized line is hard-sliced, keeping its tail.
 */
export function truncateOldest(content: string, limit: number): string {
  if (content.length <= limit) return content

  const marker = `<!-- [memory] older content truncated to fit ${limit}-char limit -->`
  const budget = Math.max(0, limit - marker.length - 1)

  const lines = content.split("\n")
  while (lines.length > 1 && lines.join("\n").length > budget) {
    lines.shift()
  }

  let body = lines.join("\n")
  if (body.length > budget) {
    body = body.slice(body.length - budget)  // keep the newest characters
  }
  return `${marker}\n${body}`
}

/** The one section of an identity file that is never dropped to fit a limit (CLEAN-150 US2). */
export const RULES_HEADING_RE = /^## rules\b/i

export interface ITruncationResult {
  text: string
  /** True when the protected rules alone exceed the limit — nothing more could be dropped. */
  over: boolean
  /** Characters removed from the non-protected content. */
  dropped: number
}

/**
 * Fit `content` into `limit` characters without touching the `## Rules`
 * section: everything else is truncated oldest-first (as `truncateOldest`),
 * and the rules are kept whole. When the rules by themselves exceed the limit
 * they are still kept and `over` is reported, so an operator sees the
 * overflow instead of losing a rule silently.
 *
 * The rules lead the result (CLEAN-207). They are the part of an identity
 * file the model must weigh most, and the head of a long prompt is where an
 * instruction is read best; 0.33.0 appended them after the reference material.
 */
export function truncateKeepingRules(content: string, limit: number): ITruncationResult {
  if (content.length <= limit) return { text: content, over: false, dropped: 0 }

  const lines = content.split("\n")
  const start = lines.findIndex(l => RULES_HEADING_RE.test(l))
  if (start === -1) {
    const text = truncateOldest(content, limit)
    return { text, over: false, dropped: content.length - text.length }
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) { end = i; break }
  }
  const rules = lines.slice(start, end).join("\n").trimEnd()
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim()

  // Two newlines join the parts and one closes the file.
  const budgetForRest = limit - rules.length - 3
  if (budgetForRest <= 0) {
    return { text: rules + "\n", over: true, dropped: rest.length }
  }
  const kept = truncateOldest(rest, budgetForRest)
  const text = kept ? `${rules}\n\n${kept}\n` : rules + "\n"
  return { text, over: false, dropped: rest.length - kept.length }
}

/** One curated file as the prompt gets it, with the numbers the agent may be asked about. */
export interface ICuratedBound {
  /** The file name, e.g. `SOUL.md`. */
  file: string
  /** The `memory.limits` value that applies, in characters. */
  limit: number
  /** Characters in the file on disk. */
  chars: number
  /** Characters of non-rule material left out of the prompt copy. */
  dropped: number
  /** The `## Rules` section alone exceeds the limit. */
  over: boolean
  /** The copy that fits. */
  text: string
}

/** Bound one curated file for the prompt; a file name outside `MEMORY_FILE_LIMITS` passes through whole. */
export function boundCurated(file: string, content: string, limits: MemoryLimits): ICuratedBound {
  const key = MEMORY_FILE_LIMITS[file]
  if (!key) return { file, limit: Number.POSITIVE_INFINITY, chars: content.length, dropped: 0, over: false, text: content }
  const limit = limits[key]
  const r = truncateKeepingRules(content, limit)
  return { file, limit, chars: content.length, dropped: r.dropped, over: r.over, text: r.text }
}
