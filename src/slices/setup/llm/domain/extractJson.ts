/**
 * Pull the one JSON object out of a model answer that may wrap it in a code
 * fence or follow it with prose that itself contains braces. Returns the
 * parsed object or null — never throws.
 */
export function extractJsonObject(text: string | undefined): Record<string, unknown> | null {
  const t = (text ?? "").trim()
  if (!t) return null
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], firstBalancedObject(t)].filter((c): c is string => !!c)
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>
    } catch {
      // try the next candidate
    }
  }
  return null
}

/** The substring from the first `{` to its matching `}` (string-aware), or undefined. */
function firstBalancedObject(t: string): string | undefined {
  const start = t.indexOf("{")
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  for (let i = start; i < t.length; i++) {
    const ch = t[i]
    if (inString) {
      if (ch === "\\") i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return t.slice(start, i + 1)
    }
  }
  return undefined
}
