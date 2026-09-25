import type { Event } from "../../../setup/event"

/**
 * Keeping the model's context inside its window (CLEAN-124).
 *
 * The session on disk keeps everything; what the model sees is a copy that
 * fits. Two guards, both by serialized size, because that is what the
 * window is made of:
 *
 * - `capPayload` bounds ONE value — a tool result, a tool call — in total.
 *   Per-string trimming was not enough: an MCP catalogue is thousands of
 *   short strings inside arrays, each one under the limit, together far
 *   over it. Arrays lose their tail first and say how many items are
 *   missing, so the model knows to ask narrower instead of guessing the
 *   list ended.
 * - `fitEventsToBudget` bounds the WHOLE history, dropping the oldest
 *   events until it fits, keeping a leading summary (that is the archive of
 *   what was dropped before) and the latest user message (the question).
 *
 * Both return the same object when nothing needs cutting, so a history that
 * fits is passed through untouched.
 */

export const TRUNCATED_ITEMS_MARK = "…[truncated: "
const MARK_RESERVE = 48

export function capPayload(value: unknown, maxChars: number): unknown {
  if (sizeOf(value) <= maxChars) return value
  return cap(value, maxChars, 0)
}

function cap(value: unknown, budget: number, depth: number): unknown {
  if (budget <= 0) return TRUNCATED_ITEMS_MARK + "omitted]"
  if (typeof value === "string") {
    if (value.length <= budget) return value
    const keep = Math.max(0, budget - MARK_RESERVE)
    return value.slice(0, keep) + `…[truncated +${value.length - keep} chars]`
  }
  if (Array.isArray(value)) {
    if (depth > 6) return TRUNCATED_ITEMS_MARK + `${value.length} items omitted]`
    const out: unknown[] = []
    let used = 2 // []
    for (let i = 0; i < value.length; i++) {
      const remaining = budget - used - MARK_RESERVE
      if (remaining <= 0) {
        out.push(TRUNCATED_ITEMS_MARK + `${value.length - i} more items omitted]`)
        return out
      }
      const item = cap(value[i], remaining, depth + 1)
      const size = sizeOf(item) + 1
      if (used + size > budget - MARK_RESERVE && i < value.length - 1) {
        out.push(TRUNCATED_ITEMS_MARK + `${value.length - i} more items omitted]`)
        return out
      }
      out.push(item)
      used += size
    }
    return out
  }
  if (value && typeof value === "object") {
    if (depth > 6) return TRUNCATED_ITEMS_MARK + "object omitted]"
    const out: Record<string, unknown> = {}
    let used = 2 // {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (let i = 0; i < entries.length; i++) {
      const [key, item] = entries[i]!
      const keySize = key.length + 4 // "key":
      const remaining = budget - used - keySize - MARK_RESERVE
      if (remaining <= 0) {
        out[TRUNCATED_ITEMS_MARK.slice(0, -2)] = `${entries.length - i} more fields omitted`
        return out
      }
      const capped = cap(item, remaining, depth + 1)
      out[key] = capped
      used += keySize + sizeOf(capped) + 1
    }
    return out
  }
  return value
}

/** JSON length: the same yardstick `estimateEventsBytes` uses. */
export function sizeOf(value: unknown): number {
  const json = JSON.stringify(value)
  return json === undefined ? 4 : json.length
}

export interface IFitResult {
  events: Event[]
  /** How many events were dropped from the front to fit. */
  dropped: number
}

/**
 * The newest events that fit `maxChars`, oldest dropped first. A leading
 * `summary` event stays (it IS the archive of earlier turns), and so does
 * the last `user` event even when it alone is over budget — the model must
 * at least see the question. When something was dropped, a short summary
 * event says so, so the model does not read the gap as "nothing happened".
 */
export function fitEventsToBudget(events: Event[], maxChars: number): IFitResult {
  const total = sizeOf(events)
  if (total <= maxChars) return { events, dropped: 0 }

  const leadingSummary = events[0]?.type === "summary" ? events[0] : null
  const body = leadingSummary ? events.slice(1) : events
  const lastUserIndex = findLastIndex(body, (e) => e.type === "user")

  const noteSize = 160
  let budget = maxChars - (leadingSummary ? sizeOf(leadingSummary) + 1 : 0) - noteSize
  const kept: Event[] = []
  // Walk from the newest back; the last user event is always taken.
  for (let i = body.length - 1; i >= 0; i--) {
    const evt = body[i]!
    const size = sizeOf(evt) + 1
    if (i === lastUserIndex || size <= budget) {
      kept.push(evt)
      budget -= size
      continue
    }
    // Everything older than the first event that does not fit goes too:
    // a history with holes in the middle reads worse than a shorter one.
    break
  }
  kept.reverse()
  // The last user event must survive even if the walk broke before it.
  if (lastUserIndex >= 0 && !kept.includes(body[lastUserIndex]!)) {
    kept.unshift(body[lastUserIndex]!)
  }
  const dropped = body.length - kept.length
  if (dropped === 0) return { events, dropped: 0 }

  const note: Event = {
    id: `context-fit-${events[events.length - 1]?.id ?? "0"}`,
    type: "summary",
    ts: kept[0]?.ts ?? Date.now(),
    data: {
      text: `[${dropped} earlier event${dropped === 1 ? "" : "s"} left out to fit the context window — ask the person if something from before is needed]`,
    },
  }
  return {
    events: [...(leadingSummary ? [leadingSummary] : []), note, ...kept],
    dropped,
  }
}

function findLastIndex<T>(items: T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i]!)) return i
  return -1
}
