/**
 * What the runtime knows about its tool servers, and the one word it sums
 * that up in (CLEAN-245). The hub receives this as `tool_state`; the prompt
 * reads the servers that are missing.
 */

export type ToolServerStateTypes = "connected" | "retrying" | "refused"
export type ToolPhaseTypes = "connecting" | "limited" | "ready"

/** One enabled bearer/header/none server. An OAuth server is one client per person and is not listed. */
export interface IToolServerState {
  /** Ranch's id of the server, when the config carried one. */
  id?: string
  name: string
  state: ToolServerStateTypes
  /** ISO time it entered this state. */
  since: string
  /** Attempts since it last was connected; 0 when connected. */
  attempts: number
  /** Redacted, first line, at most 300 characters. Absent when connected. */
  lastError?: string
}

export interface IToolState {
  phase: ToolPhaseTypes
  /** ISO time this phase began. */
  since: string
  /** ISO time the runtime started: the waiting limit counts from here. */
  startedAt: string
  servers: IToolServerState[]
}

const DEFAULT_START_GRACE_MS = 60_000

/** How long after start a missing server reads as `connecting` rather than `limited` (`MCP_START_GRACE_MS`). */
export function startGraceMs(): number {
  const value = Number(process.env.MCP_START_GRACE_MS)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_START_GRACE_MS
}

/**
 * A server that drops after the start is not a mark until it has been away
 * this long: an API restart lasts seconds and would otherwise flash
 * "limited" on every agent of the Ranch at once.
 */
export const LATER_DROP_MS = 15_000

/**
 * The phase of an agent, from its servers and its own age.
 *
 * - nothing missing → `ready`;
 * - within the waiting limit with a server still being tried → `connecting`;
 * - a refused server → `limited` (waiting changes nothing);
 * - past the limit, a server that was already missing when the limit ran
 *   out, or has been away for `LATER_DROP_MS` or more → `limited`.
 */
export function phaseOf(
  servers: IToolServerState[],
  startedAt: number,
  now: number,
  graceMs = startGraceMs(),
): ToolPhaseTypes {
  const retrying = servers.filter((s) => s.state === "retrying")
  const refused = servers.some((s) => s.state === "refused")
  if (retrying.length === 0 && !refused) return "ready"
  if (retrying.length > 0 && now - startedAt < graceMs) return "connecting"
  if (refused) return "limited"
  return retrying.some((s) => isMark(Date.parse(s.since), startedAt, now, graceMs)) ? "limited" : "ready"
}

/** Past the waiting limit: does a server missing since `since` count against the agent yet? */
function isMark(since: number, startedAt: number, now: number, graceMs: number): boolean {
  // Missing since before the limit ran out: it was waited for already.
  if (since < startedAt + graceMs) return true
  return now - since >= LATER_DROP_MS
}

/**
 * When `phaseOf` may answer differently with nothing else changing, or null
 * when only a change of a server can move it. The service sets one timer.
 */
export function nextPhaseCheckAt(
  servers: IToolServerState[],
  startedAt: number,
  now: number,
  graceMs = startGraceMs(),
): number | null {
  const retrying = servers.filter((s) => s.state === "retrying")
  if (retrying.length === 0) return null
  if (now - startedAt < graceMs) return startedAt + graceMs
  const sinces = retrying.map((s) => Date.parse(s.since))
  if (sinces.some((since) => isMark(since, startedAt, now, graceMs))) return null
  return Math.min(...sinces.map((since) => since + LATER_DROP_MS))
}

const MAX_ERROR_LENGTH = 300

/**
 * An error as it may leave the pod: its first line, without anything that
 * could be a credential (an `Authorization` value, a bearer, a query
 * string), and never a page of HTML — a proxy's error page says nothing the
 * status code does not.
 *
 * `secrets` are the values this server's config holds (its token, its header
 * value): each is removed wherever it stands, whatever surrounds it — the
 * patterns below only know the usual shapes.
 */
export function redactError(err: unknown, secrets: Array<string | undefined> = []): string {
  let raw = err instanceof Error ? err.message : String(err ?? "")
  for (const secret of secrets) {
    const value = secret?.trim()
    if (value && value.length >= 4) raw = raw.split(value).join("[redacted]")
  }
  const code = (err as { code?: unknown } | null)?.code
  if (/<\s*(!doctype|html|head|body)\b/i.test(raw)) {
    return typeof code === "number" ? `HTTP ${code}` : "the server answered with an error page"
  }
  const line = (raw.split(/\r?\n/).find((l) => l.trim()) ?? "").trim()
  const clean = line
    .replace(/(authorization|x-[\w-]*(key|token)[\w-]*|api[-_]?key|token|secret|password)(["']?\s*[:=]\s*)(bearer\s+)?["']?[^\s"',;]+/gi, "$1$3[redacted]")
    .replace(/\bbearer\s+[\w.~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1")
    .replace(/\?[^\s"')]*/g, "")
  return clean.length > MAX_ERROR_LENGTH ? `${clean.slice(0, MAX_ERROR_LENGTH - 1)}…` : clean
}
