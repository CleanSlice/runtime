// Runtime logger.
//
// A single formatter behind every log line in the runtime. Replaces scattered
// `console.log("[tag] ...")` calls with `createLogger("tag")`.
//
// Output line (pretty mode):
//
//   14:23:01.512  ·  llm      auxiliary model — claude/claude-haiku-4-5
//   └ time ─────┘  │  └ tag ┘ └ message ──────────────────────────────┘
//                  └ level glyph
//
// Features:
//   • level filtering via LOG_LEVEL (debug | info | warn | error, default info)
//   • pretty (TTY) vs JSON (LOG_FORMAT=json) — JSON for log aggregation
//   • deterministic per-tag color; a `child(id)` logger colors each request id
//     differently so interleaved request flows are easy to follow by eye
//   • multi-line blobs (stack traces, API error bodies) collapse to one line
//     + a "+N more lines" hint; full text shown only at LOG_LEVEL=debug
//   • consecutive identical lines deduplicate to "↳ last line repeated ×N"
//   • secret redaction on every line (see redact.ts)

import { redact } from "./redact"

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface Logger {
  debug(msg: string): void
  info(msg: string): void
  /** Like `info`, but prints a ✓ glyph for successful outcomes. */
  ok(msg: string): void
  warn(msg: string, err?: unknown): void
  error(msg: string, err?: unknown): void
  /**
   * Scoped child logger. `id` becomes the tag (e.g. a 6-char request id).
   * Each distinct id gets its own stable color, so the lines of one request
   * stand out among interleaved requests.
   */
  child(id: string): Logger
}

// ─── Config (resolved once at module load) ──────────────────────────────────

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

function resolveMinRank(): number {
  const env = process.env.LOG_LEVEL
  return env && env in RANK ? RANK[env as LogLevel] : RANK.info
}

const MIN_RANK = resolveMinRank()
const JSON_MODE = process.env.LOG_FORMAT === "json"
const COLOR =
  !JSON_MODE &&
  process.env.NO_COLOR === undefined &&
  (process.env.FORCE_COLOR !== undefined || process.stdout.isTTY === true)

// ─── Formatting primitives ───────────────────────────────────────────────────

const ansi = (code: number, s: string): string => (COLOR ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s: string): string => ansi(2, s)

// Foreground colors used to tint tags. Chosen by hashing the tag name so a
// given subsystem (or request id) always renders in the same color.
const TAG_COLORS = [36, 32, 33, 34, 35, 31, 96, 92, 94, 95]
function tagColor(tag: string): number {
  let h = 0
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) >>> 0
  return TAG_COLORS[h % TAG_COLORS.length]
}

type Glyph = LogLevel | "ok"
const GLYPH: Record<Glyph, string> = { debug: "·", info: "·", ok: "✓", warn: "⚠", error: "✗" }
const GLYPH_COLOR: Record<Glyph, number> = { debug: 2, info: 90, ok: 32, warn: 33, error: 31 }

const TAG_WIDTH = 8
// time(12) + "  " + glyph(1) + "  " + tag(8) + " " = 26
const CONT_INDENT = " ".repeat(26)
const MAX_HEAD = 200

function timestamp(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, "0")
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}

/** Collapse a possibly multi-line blob into a one-line head + the rest. */
function compact(text: string): { head: string; rest: string[] } {
  const lines = text.split("\n").filter((l, i) => i === 0 || l.trim().length > 0)
  let head = (lines[0] ?? "").trimEnd()
  if (head.length > MAX_HEAD) head = head.slice(0, MAX_HEAD) + "…"
  return { head, rest: lines.slice(1).map((l) => l.trimEnd()) }
}

function errText(err: unknown): string {
  if (err == null) return ""
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

// ─── Consecutive-duplicate suppression (pretty mode only) ────────────────────

let lastKey = ""
let repeatCount = 0

function flushRepeat(): void {
  if (repeatCount > 1) {
    process.stdout.write(`${CONT_INDENT}${dim(`↳ last line repeated ×${repeatCount}`)}\n`)
  }
  repeatCount = 0
  lastKey = ""
}
process.on("exit", flushRepeat)

// ─── Core write ──────────────────────────────────────────────────────────────

function write(tag: string, level: Glyph, msg: string, err?: unknown): void {
  const lvl: LogLevel = level === "ok" ? "info" : level
  if (RANK[lvl] < MIN_RANK) return

  const raw = err != null ? `${msg}\n${errText(err)}` : msg
  const { head, rest } = compact(redact(raw))
  const stream = lvl === "warn" || lvl === "error" ? process.stderr : process.stdout

  if (JSON_MODE) {
    stream.write(
      JSON.stringify({
        t: new Date().toISOString(),
        level: lvl,
        tag,
        msg: head,
        ...(rest.length ? { detail: rest.join("\n") } : {}),
      }) + "\n",
    )
    return
  }

  // suppress consecutive identical lines
  const key = `${tag}|${level}|${head}`
  if (key === lastKey) {
    repeatCount++
    return
  }
  flushRepeat()
  lastKey = key
  repeatCount = 1

  const glyph = ansi(GLYPH_COLOR[level], GLYPH[level])
  const tagStr = ansi(tagColor(tag), tag.padEnd(TAG_WIDTH))
  const body = lvl === "error" ? ansi(31, head) : lvl === "warn" ? ansi(33, head) : head
  stream.write(`${dim(timestamp())}  ${glyph}  ${tagStr} ${body}\n`)

  if (rest.length) {
    if (MIN_RANK === RANK.debug) {
      for (const line of rest) stream.write(`${CONT_INDENT}${dim(line)}\n`)
    } else {
      const n = rest.length
      stream.write(`${CONT_INDENT}${dim(`↳ +${n} more line${n > 1 ? "s" : ""} — set LOG_LEVEL=debug to expand`)}\n`)
    }
  }
}

// ─── Public factory ──────────────────────────────────────────────────────────

export function createLogger(subsystem: string): Logger {
  const make = (tag: string): Logger => ({
    debug: (m) => write(tag, "debug", m),
    info: (m) => write(tag, "info", m),
    ok: (m) => write(tag, "ok", m),
    warn: (m, e) => write(tag, "warn", m, e),
    error: (m, e) => write(tag, "error", m, e),
    child: (id) => make(id),
  })
  return make(subsystem)
}
