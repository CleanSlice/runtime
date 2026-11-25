/**
 * When a tool server is tried again, and which failures are worth it
 * (CLEAN-245). Pure: the gateway and the service ask, nothing here waits.
 */

/** The first pauses after a failure; after them, `MCP_RETRY_MAX_MS` for as long as the agent runs. */
export const RETRY_STEPS_MS = [5_000, 10_000, 20_000, 40_000]
/** Each pause is moved by up to this share either way: every agent of a Ranch loses the same server at the same second. */
export const RETRY_JITTER = 0.2

const DEFAULT_RETRY_MAX_MS = 60_000
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** Ceiling of the pause between attempts (`MCP_RETRY_MAX_MS`). */
export const retryMaxMs = (): number => positiveEnv("MCP_RETRY_MAX_MS", DEFAULT_RETRY_MAX_MS)
/** How long one attempt to open a server may take (`MCP_CONNECT_TIMEOUT_MS`). */
export const connectTimeoutMs = (): number => positiveEnv("MCP_CONNECT_TIMEOUT_MS", DEFAULT_CONNECT_TIMEOUT_MS)

/**
 * The pause before the next attempt, after `failed` attempts in a row.
 * `rand` is `Math.random` in production and a constant in a spec.
 */
export function nextDelayMs(failed: number, rand: () => number = Math.random, maxMs = retryMaxMs()): number {
  const step = RETRY_STEPS_MS[Math.max(failed, 1) - 1] ?? maxMs
  const base = Math.min(step, maxMs)
  return Math.round(base * (1 + (rand() * 2 - 1) * RETRY_JITTER))
}

/**
 * The server no longer knows the session this client holds (CLEAN-232, R17).
 * Ranch keeps MCP sessions in memory, so every API restart answers the next
 * request with HTTP 404 and a JSON-RPC body `-32000 "Session not found"`.
 * The SDK's `StreamableHTTPClientTransport.send` turns a non-OK POST into
 * `StreamableHTTPError(response.status, "Error POSTing to endpoint: <body>")`,
 * so the status is on `code` and the body's words are in `message`; the SSE
 * transport puts `(HTTP 404)` in the message instead.
 *
 * The server answered, so the request was not run: repeating it is safe
 * whatever the tool does.
 */
export function isLostSession(err: unknown): boolean {
  if (!(err instanceof Error) || isToolAnswer(err)) return false
  if ((err as { code?: unknown }).code === 404) return true
  return /session not found|\(HTTP 404\)/i.test(err.message)
}

/**
 * A JSON-RPC error: the server received the request and answered it, so the
 * connection is fine whatever the words say. A tool's own failure text
 * ("fetch failed", "upstream said (HTTP 403)") comes from the pages and
 * services it touches, and must never read as the state of the server.
 * The one exception is the SDK's own notice that the transport closed
 * under a pending request.
 */
function isToolAnswer(err: Error): boolean {
  if (err.name !== "McpError") return false
  return !/^MCP error -32000: Connection closed$/.test(err.message)
}

const BROKEN_STATUS = new Set([502, 503, 504])
const BROKEN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT", "ConnectionRefused", "ConnectionClosed"])
const BROKEN_WORDS =
  /ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|fetch failed|socket hang up|unable to connect|connection (refused|reset|closed)|\(HTTP 50[234]\)/i

/**
 * The request did not get an answer from the server: nothing listened, the
 * connection went away, or a proxy in front said the server is not there
 * (502/503/504). Whether the server ran the request is not known — which is
 * why only a read is repeated after it.
 */
export function isBrokenConnection(err: unknown): boolean {
  if (!(err instanceof Error) || isToolAnswer(err)) return false
  const code = (err as { code?: unknown }).code
  if (typeof code === "number" && BROKEN_STATUS.has(code)) return true
  if (typeof code === "string" && BROKEN_CODES.has(code)) return true
  const cause = (err as { cause?: unknown }).cause
  if (cause instanceof Error && cause !== err && isBrokenConnection(cause)) return true
  return BROKEN_WORDS.test(err.message)
}

/**
 * The server answered and refused this agent's credentials (401/403).
 * Waiting does not fix a credential, so such a server is not tried again.
 */
export function isRefused(err: unknown): boolean {
  if (!(err instanceof Error) || isToolAnswer(err)) return false
  if (err.name === "UnauthorizedError") return true
  const code = (err as { code?: unknown }).code
  if (code === 401 || code === 403) return true
  // The SSE transport has no status field: it writes the code into its own message.
  return /^SSE error: .*\(HTTP 40[13]\)$/i.test(err.message)
}
