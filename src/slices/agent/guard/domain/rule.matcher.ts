// Pure matching for guard rules: tool globs, argument paths, result regexes.
// No I/O, no logging — the service decides what a match means.
import { posix } from "path"
import type { IRuleMatch } from "./guard.types"

const globCache = new Map<string, RegExp>()

/** `exec`, `exec|file`, `ranch__*`, `*` — `*` is the only wildcard, `|` separates alternatives. */
export function matchesTool(glob: string, name: string): boolean {
  let re = globCache.get(glob)
  if (!re) {
    const alternatives = glob.split("|").map(g => g.trim()).filter(Boolean)
      .map(g => g.split("*").map(escapeRegex).join(".*"))
    re = new RegExp(`^(?:${alternatives.join("|")})$`)
    globCache.set(glob, re)
  }
  return re.test(name)
}

/** Value at a `$`-rooted dot path, or `undefined` when any step is missing. */
export function valueAtPath(params: unknown, path: string): unknown {
  if (path === "$") return params
  const steps = path.replace(/^\$\.?/, "").split(".").filter(Boolean)
  let cur: unknown = params
  for (const step of steps) {
    if (cur === null || typeof cur !== "object") return undefined
    cur = (cur as Record<string, unknown>)[step]
  }
  return cur
}

/**
 * Does the argument rule match these params? The value is tested as text,
 * both as written and with relative path tokens resolved against the agent
 * dir, so `cat data/secrets/x` and `cat /agent/data/secrets/x` read alike.
 */
export function argMatches(arg: NonNullable<IRuleMatch["arg"]>, params: unknown, agentDir: string): boolean {
  const value = valueAtPath(params, arg.path)
  if (value === undefined) return false
  const re = new RegExp(arg.pattern)
  // An object is tested both as the raw strings it carries (so a quote inside
  // a shell command is a quote, not `\"`) and as JSON (so keys and numbers
  // are reachable too).
  return textsOf(value).some(text => re.test(text) || re.test(resolveRelativePaths(text, agentDir)))
}

function textsOf(value: unknown): string[] {
  if (typeof value === "string") return [value]
  const leaves: string[] = []
  const walk = (v: unknown): void => {
    if (typeof v === "string") leaves.push(v)
    else if (Array.isArray(v)) v.forEach(walk)
    else if (v && typeof v === "object") Object.values(v as Record<string, unknown>).forEach(walk)
  }
  walk(value)
  return leaves.length > 0 ? [leaves.join("\n"), serialize(value)] : [serialize(value)]
}

/** Does the result rule match this result? */
export function resultMatches(pattern: string, result: unknown): boolean {
  return new RegExp(pattern).test(serialize(result))
}

// A path-like token: optional ./ or ../ prefix, then at least one slash
// between name segments. Not preceded by a word char, slash, dot or colon
// (so URL paths and absolute paths stay untouched).
const RELATIVE_PATH_RE = /(?<![\w/.:-])((?:\.{1,2}\/)*)([\w.-]+(?:\/[\w.-]+)+)/g

/** Rewrite relative path tokens in `text` as absolute paths under `agentDir`. */
export function resolveRelativePaths(text: string, agentDir: string): string {
  const base = agentDir.replace(/\\/g, "/")
  return text.replace(RELATIVE_PATH_RE, (whole, dots: string, rest: string, offset: number) => {
    // Something like "x/y" directly after a scheme separator is a URL path.
    if (text.slice(0, offset).match(/:\/\/[^\s]*$/)) return whole
    return posix.resolve(base, dots + rest)
  })
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
